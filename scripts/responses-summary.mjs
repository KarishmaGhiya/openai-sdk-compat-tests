import { readFile } from 'node:fs/promises';
import { appendStepSummary } from '../lib/io.mjs';
import { pathToFileURL } from 'node:url';
import { caseLogMarker, renderLiveSummary, renderResponsesSummary } from '../lib/compat-summary.mjs';
import { appInstallationToken, defaultIssueRepos, fileFailureIssues, revokeInstallationToken } from './failure-issues.mjs';

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

export async function main({ reportFile = 'reports/azure-live.json', offlineReportFile = 'reports/responses-compatibility.json', env = process.env } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  const runUrl = `https://github.com/${repository}/actions/runs/${run}`;
  let report;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); } catch {
    const missing = `| Test | Result |\n| --- | --- |\n| Live run | [No live report was produced; see logs](${runUrl}) |\n`;
    await appendStepSummary(missing, env);
    console.log(missing);
    return;
  }
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
  report.links = { ...report.links, run: runUrl };
  if (env.ISSUES_APP_CLIENT_ID && env.ISSUES_APP_PRIVATE_KEY) {
    // Each kind's repo can be overridden with OPENAPI_ISSUE_REPO, SDK_ISSUE_REPO, or AZURE_ISSUE_REPO.
    const repos = Object.fromEntries(Object.entries(defaultIssueRepos)
      .map(([kind, repo]) => [kind, env[`${kind.toUpperCase()}_ISSUE_REPO`] || repo]));
    let token;
    try {
      token = await appInstallationToken({ clientId: env.ISSUES_APP_CLIENT_ID, privateKey: env.ISSUES_APP_PRIVATE_KEY, repos });
      const { links, filed } = await fileFailureIssues({ report, token, repos });
      report.links.issues = links;
      report.issueSummary = filed;
    } catch (error) {
      console.log(`::warning::Failure issues were not filed (${error.message}).`);
    } finally {
      if (token) await revokeInstallationToken(token);
    }
  } else {
    const reason = env.ISSUES_APP_CLIENT_ID ? 'the App private key could not be read (check the Azure login and Key Vault access)' : 'the issue-filing GitHub App is not configured';
    console.log(`::notice::Failure issues were not filed: ${reason}.`);
  }
  let summary = renderLiveSummary(report);
  // Configured mode defers the offline findings too, so the issue summary stays first on the run page.
  if (report.summaryMode !== 'responses-core') {
    try { summary += `\n${renderResponsesSummary(JSON.parse(await readFile(offlineReportFile, 'utf8')))}`; } catch {}
  }
  await appendStepSummary(summary, env);
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Responses summary failed; details redacted.'); process.exitCode = 1; });
}
