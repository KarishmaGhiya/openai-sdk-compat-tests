import { makeLiveClients, runLiveMatrix, validateLivePrerequisites } from '../lib/azure-live.mjs';
import { writeJSON } from '../lib/io.mjs';
import { pathToFileURL } from 'node:url';

export async function main(raw = process.env.AZURE_COMPAT_CONFIG_JSON) {
  if (process.env.ALLOW_LIVE_API !== 'true') throw new Error('Set ALLOW_LIVE_API=true to authorize paid live tests.');
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Missing/invalid AZURE_COMPAT_CONFIG_JSON; value redacted.'); }
  await validateLivePrerequisites(config);
  const versions = {};
  const { readJSON } = await import('../lib/io.mjs');
  for (const name of ['openai', 'openai-current', 'azure-openai-legacy']) {
    versions[name] = (await readJSON(`node_modules/${name}/package.json`)).version;
  }
  const results = await runLiveMatrix(config, makeLiveClients(config));
  await writeJSON('reports/azure-live.json', {
    versions, suites: config.suites, live: true,
    scope: 'Selected suites only; not exhaustive API or semantic model equivalence.',
    results,
  });
  for (const entry of results) console.log(`${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${entry.client} ${entry.suite}`);
  if (results.some((entry) => entry.status === 'failed')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Azure live test configuration/execution failed; details redacted.'); process.exitCode = 1; });
}
