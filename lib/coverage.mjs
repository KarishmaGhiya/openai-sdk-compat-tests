import { compareVersions } from './io.mjs';

export function applicableCases(cases, version) {
  const ids = new Set();
  for (const entry of cases) {
    if (ids.has(entry.id)) throw new Error(`Duplicate case ID: ${entry.id}`);
    ids.add(entry.id);
    if (!/^\d+\.\d+\.\d+$/.test(entry.since)) throw new Error(`Invalid since version: ${entry.id}`);
    if (entry.until && !/^\d+\.\d+\.\d+$/.test(entry.until)) throw new Error(`Invalid until version: ${entry.id}`);
    if (!Array.isArray(entry.covers) || !entry.covers.length) throw new Error(`Missing covers: ${entry.id}`);
  }
  return cases.filter((entry) => compareVersions(entry.since, version) <= 0 &&
    (!entry.until || compareVersions(version, entry.until) <= 0));
}

export function validateCase(entry, fixtures) {
  const errors = [];
  if (entry.ready !== true) errors.push('not reviewed (ready must be true)');
  if (!Array.isArray(entry.steps) || !entry.steps.length) errors.push('no scenario steps');
  const stepIds = new Set();
  const steps = [...(entry.steps ?? []), ...(entry.cleanup ?? [])];
  for (const step of steps) {
    if (!step.id || stepIds.has(step.id)) errors.push(`missing/duplicate step ID: ${step.id}`);
    stepIds.add(step.id);
    if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(step.method ?? '') ||
      step.method.split('.').some((part) => ['constructor', 'prototype', '__proto__'].includes(part))) {
      errors.push(`invalid SDK method: ${step.id}`);
    }
    const args = step.fixture ? fixtures[step.fixture]?.args : step.args;
    if (!Array.isArray(args)) errors.push(`missing argument array for ${step.id}${step.fixture ? ` (${step.fixture})` : ''}`);
    if (!Number.isInteger(step.optionsIndex) || step.optionsIndex < (args?.length ?? 0)) {
      errors.push(`invalid request-options index for ${step.id}`);
    }
    if (!Array.isArray(step.assertions) || !step.assertions.length) {
      errors.push(`no response assertions for ${step.id}`);
    } else {
      for (const assertion of step.assertions) {
        if (!['exists', 'equals', 'type', 'nonEmpty', 'includes', 'greaterThan', 'matches'].includes(assertion.op) ||
          typeof assertion.path !== 'string') errors.push(`invalid assertion for ${step.id}`);
        if (['equals', 'type', 'includes', 'greaterThan', 'matches'].includes(assertion.op) && !('value' in assertion)) {
          errors.push(`missing assertion value for ${step.id}`);
        }
      }
    }
    if (step.capture !== undefined && !['json', 'text', 'bytes', 'stream'].includes(step.capture)) {
      errors.push(`invalid capture mode for ${step.id}`);
    }
  }
  // Feature obligations must explicitly identify the assertion-bearing step exercising them.
  for (const obligation of entry.covers.filter((id) => !id.startsWith('endpoint:'))) {
    const evidence = entry.evidence?.[obligation];
    if (!Array.isArray(evidence) || !evidence.length ||
      evidence.some((id) => !entry.steps?.some((step) => step.id === id && step.assertions?.length))) {
      errors.push(`missing feature evidence for ${obligation}`);
    }
  }
  for (const obligation of entry.covers.filter((id) => id.startsWith('endpoint:'))) {
    if (!steps.some((step) => step.method === obligation.slice('endpoint:'.length))) {
      errors.push(`endpoint not exercised: ${obligation}`);
    }
  }
  return errors;
}

export function coverageReport(releases, cases, fixtures, version) {
  const release = releases.find((entry) => entry.version === version);
  if (!release) throw new Error(`No discovered release ${version}; run npm run discover.`);
  const relevant = releases.filter((entry) => compareVersions(entry.version, version) <= 0);
  const obligations = [
    ...release.methods.map((method) => `endpoint:${method}`),
    ...relevant.flatMap((entry) => entry.requirements.map((requirement) => requirement.id)),
  ];
  const selected = applicableCases(cases, version);
  const valid = [];
  const drafts = [];
  for (const entry of selected) {
    const errors = validateCase(entry, fixtures);
    if (errors.length) drafts.push({ id: entry.id, errors });
    else valid.push(entry);
  }

  const covered = new Set(valid.flatMap((entry) => entry.covers));
  const missing = obligations.filter((id) => !covered.has(id));
  const baselineMissing = release.baselineMissing ?? [];
  return {
    version, required: obligations.length, covered: obligations.length - missing.length,
    missing, baselineMissing, drafts, runnable: valid.map((entry) => entry.id),
    complete: missing.length === 0 && baselineMissing.length === 0,
  };
}

export function livePlan(releases, cases, fixtures, version, selection) {
  const report = coverageReport(releases, cases, fixtures, version);
  const baselineReport = coverageReport(releases, cases, fixtures, '7.3.0');
  if (selection && (!selection.length || selection.some((id) => !id) || new Set(selection).size !== selection.length)) {
    throw new Error('LIVE_CASES must contain nonempty, distinct case IDs.');
  }
  if (!selection && !baselineReport.complete) {
    return { report, blocked: true, cases: [], baselineMissing: baselineReport.missing };
  }
  const selectedIds = selection ?? report.runnable;
  const selected = selectedIds.map((id) => {
    const entry = cases.find((entry) => entry.id === id);
    if (!entry || !report.runnable.includes(id)) {
      throw new Error(`Case ${id} is unavailable or unconfigured: ${entry ? validateCase(entry, fixtures).join('; ') : 'unknown ID'}`);
    }
    return entry;
  });
  return { report, blocked: false, cases: selected };
}
