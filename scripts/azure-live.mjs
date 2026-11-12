import { makeLiveClients, runLiveMatrix, validateLivePrerequisites } from '../lib/azure-live.mjs';
import { writeJSON } from '../lib/io.mjs';
import { pathToFileURL } from 'node:url';
import { makeResponsesLiveClients, runResponsesLiveMatrix } from '../lib/responses-live.mjs';

export async function main(raw = process.env.AZURE_COMPAT_CONFIG_JSON) {
  if (process.env.ALLOW_LIVE_API !== 'true') throw new Error('Set ALLOW_LIVE_API=true to authorize paid live tests.');
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Missing/invalid AZURE_COMPAT_CONFIG_JSON; value redacted.'); }
  const responsesPlan = await validateLivePrerequisites(config);
  const versions = {};
  const { readJSON } = await import('../lib/io.mjs');
  for (const name of ['openai', 'openai-current', 'azure-openai-legacy']) {
    versions[name] = (await readJSON(`node_modules/${name}/package.json`)).version;
  }
  const blocked = responsesPlan?.missing.length > 0;
  const results = blocked ? [] : await runLiveMatrix(config, makeLiveClients(config));
  let responses;
  if (config.suites.includes('responses')) {
    responses = await runResponsesLiveMatrix(config, blocked ? [] : await makeResponsesLiveClients(config));
    results.push(...responses.results.map((entry) => ({ ...entry, suite: 'responses' })));
  }
  await writeJSON('reports/azure-live.json', {
    versions, suites: config.suites, live: !blocked,
    scope: 'Selected suites only; not exhaustive API or semantic model equivalence.',
    ...(responses ? { responses: { mode: responses.mode, complete: responses.complete }, blockedBeforePaidCalls: blocked } : {}), results,
  });
  for (const entry of results) console.log(`${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${entry.client ?? entry.provider} ${entry.feature ?? entry.suite} (${entry.status})`);
  if (results.some((entry) => entry.status !== 'passed')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Azure live test configuration/execution failed; details redacted.'); process.exitCode = 1; });
}
