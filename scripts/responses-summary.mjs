import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { caseLogMarker, renderLiveSummary } from '../lib/compat-summary.mjs';

export const liveJobName = 'live';
export const liveStepName = 'Fetch Key Vault configuration in memory and run live tests';

// GitHub numbers a step's log lines from 1 at its "##[group]Run ..." header; job logs prefix each line with a timestamp.
export function caseLineLinks(logText, report, stepUrl) {
  const lines = logText.split(/\r?\n/).map((line) => line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\S+Z ?/, ''));
  const links = {};
  for (const row of report.results ?? []) {
    const marker = `${caseLogMarker(row)}: `;
    const index = lines.findIndex((line) => line.startsWith(marker));
    if (index < 0) continue;
    let start = index;
    while (start >= 0 && !lines[start].startsWith('##[group]Run ')) start--;
    if (start < 0) continue;
    links[caseLogMarker(row)] = `${stepUrl}:${index - start + 2}`;
  }
  return links;
}

async function github(path, token, accept = 'application/vnd.github+json') {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  return accept.includes('json') ? response.json() : response.text();
}

export async function main({ reportFile = 'reports/azure-live.json', env = process.env } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  const runUrl = `https://github.com/${repository}/actions/runs/${run}`;
  let report;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); } catch {
    const missing = `| Test | Result |\n| --- | --- |\n| Responses-core | [No live report was produced; see logs](${runUrl}) |\n`;
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, missing);
    console.log(missing);
    return;
  }
  report.summaryMode = 'responses-core';
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(run ?? '') || !/^\d+$/.test(attempt) || !env.GH_TOKEN) {
      throw new Error('Missing GitHub run context');
    }
    const { jobs } = await github(`repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`, env.GH_TOKEN);
    const job = jobs.find((entry) => entry.name === liveJobName);
    const step = job?.steps?.find((entry) => entry.name === liveStepName);
    if (!job || !step) throw new Error('Live job step not found');
    const stepUrl = `${job.html_url}#step:${step.number}`;
    const log = await github(`repos/${repository}/actions/jobs/${job.id}/logs`, env.GH_TOKEN, 'application/vnd.github.raw');
    report.links = { ...report.links, logs: `${stepUrl}:1`, cases: caseLineLinks(log, report, stepUrl) };
    console.log(`Linked ${Object.keys(report.links.cases).length} of ${report.results.length} cases to exact log lines.`);
  } catch (error) {
    console.log(`::warning::Exact log-line links unavailable (${error.message}); linking to the live step instead.`);
  }
  const summary = renderLiveSummary(report);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Responses summary failed; details redacted.'); process.exitCode = 1; });
}
