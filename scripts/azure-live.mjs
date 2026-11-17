import { makeLiveClients, runLiveMatrix, selectLiveMode, validateLivePrerequisites } from '../lib/azure-live.mjs';
import { root, writeJSON } from '../lib/io.mjs';
import { pathToFileURL } from 'node:url';
import { makeResponsesLiveClients, runResponsesLiveMatrix } from '../lib/responses-live.mjs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderLiveSummary, renderResponsesCaseLog } from '../lib/compat-summary.mjs';
import { CompanionPrerequisiteError, runCompanionLiveMatrix } from '../lib/azure-companion-live.mjs';

export async function writeLiveReport(report, reportFile = 'reports/azure-live.json') {
  if (process.env.AZURE_COMPAT_MODE === 'responses-core') {
    report.summaryMode = 'responses-core';
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const run = process.env.GITHUB_RUN_ID;
    if (/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && /^[a-f0-9]{40}$/.test(sha ?? '') && /^\d+$/.test(run ?? '')) {
      const source = await readFile(join(root, 'lib', 'responses-live.mjs'), 'utf8');
      const lines = source.split('\n');
      const line = lines.findIndex((line) => line.startsWith('export async function runResponsesBuiltin(')) + 1;
      const sourceURL = `https://github.com/${repository}/blob/${sha}/lib/responses-live.mjs`;
      report.links = {
        source: `${sourceURL}${line ? `#L${line}` : ''}`,
        tests: Object.fromEntries([...new Set(report.results.map((row) => row.feature))].filter((id) => /^method:[\w.]+$/.test(id ?? '')).map((id) => {
          const index = lines.findIndex((text, index) => index >= line && text.includes(`id === '${id}'`));
          return [id, `${sourceURL}#L${index < 0 ? line : index + 1}`];
        })),
        logs: process.env.RESPONSES_LIVE_LOG_URL || `https://github.com/${repository}/actions/runs/${run}`,
      };
    }
    for (const row of report.results) {
      const log = renderResponsesCaseLog(row);
      console.log(`::group::${log.split('\n')[0]}`);
      console.log(log);
      console.log('::endgroup::');
    }
  }
  await writeJSON(reportFile, report);
  const summary = renderLiveSummary(report);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  for (const entry of report.results) console.log(`${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${entry.client ?? entry.provider} ${entry.feature ?? entry.suite} (${entry.status})`);
  if (report.blockedBeforePaidCalls || report.results.some((entry) => entry.status !== 'passed')) process.exitCode = 1;
}

export function writeCompanionPreflight(error, reportFile) {
  return writeLiveReport({
    suites: ['azure-companion'], live: false, blockedBeforePaidCalls: true,
    setupFailure: 'companion-prerequisites', results: error.results,
  }, reportFile);
}

export async function main(raw = process.env.AZURE_COMPAT_CONFIG_JSON, { reportFile } = {}) {
  if (process.env.ALLOW_LIVE_API !== 'true') throw new Error('Set ALLOW_LIVE_API=true to authorize paid live tests.');
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Missing/invalid AZURE_COMPAT_CONFIG_JSON; value redacted.'); }
  config = selectLiveMode(config);
  let responsesPlan;
  try { responsesPlan = await validateLivePrerequisites(config); } catch (error) {
    if (!(error instanceof CompanionPrerequisiteError)) throw error;
    await writeCompanionPreflight(error, reportFile);
    return;
  }
  const versions = {};
  const { readJSON } = await import('../lib/io.mjs');
  for (const name of ['openai', 'openai-current', '@azure/openai', 'azure-openai-legacy']) {
    versions[name] = (await readJSON(`node_modules/${name}/package.json`)).version;
  }
  const blocked = responsesPlan?.missing.length > 0;
  const results = blocked ? [] : await runLiveMatrix(config, makeLiveClients(config));
  let responses;
  if (config.suites.includes('responses')) {
    responses = await runResponsesLiveMatrix(config, blocked ? [] : await makeResponsesLiveClients(config));
    results.push(...responses.results.map((entry) => ({ ...entry, suite: 'responses' })));
  }
  const companion = !blocked && config.suites.includes('azure-companion') ? await runCompanionLiveMatrix(config) : undefined;
  if (companion) results.push(...companion.results);
  const report = {
    versions, suites: config.suites, live: !blocked,
    scope: 'Selected suites only; not exhaustive API or semantic model equivalence.',
    ...(responses ? { responses: { mode: responses.mode, complete: responses.complete }, blockedBeforePaidCalls: blocked } : {}),
    ...(companion ? { companion: { ...companion, results: undefined } } : {}), results,
  };
  await writeLiveReport(report, reportFile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Azure live test configuration/execution failed; details redacted.'); process.exitCode = 1; });
}
