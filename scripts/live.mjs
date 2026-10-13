import { dirname, resolve } from 'node:path';
import { livePlan } from '../lib/coverage.mjs';
import { executeScenario } from '../lib/scenario.mjs';
import { readJSON, root, writeJSON } from '../lib/io.mjs';

const actual = (await readJSON('node_modules/openai/package.json')).version;
const version = process.env.SDK_VERSION ?? actual;
if (version !== actual) throw new Error(`Requested ${version}, but installed SDK is ${actual}.`);
const { releases } = await readJSON('releases.json');
const allCases = [...await readJSON('cases/catalog.json'), ...await readJSON('cases/builtins.json')];
const fixturePath = process.env.LIVE_FIXTURES ?? 'fixtures/live.json';
const fixtures = await readJSON(fixturePath);
const selection = process.env.LIVE_CASES ? process.env.LIVE_CASES.split(',').map((id) => id.trim()) : undefined;
const plan = livePlan(releases, allCases, fixtures, version, selection);
const { report, cases } = plan;
await writeJSON(`reports/coverage-${version}.json`, report);
if (plan.blocked) {
  throw new Error(`Coverage incomplete: ${plan.baselineMissing.length} baseline obligations lack configured tests. See reports/coverage-${version}.json. No billable requests made.`);
}
if (process.env.ALLOW_LIVE_API !== 'true') throw new Error('Set ALLOW_LIVE_API=true to authorize real paid/mutating API calls.');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
if (process.env.OPENAI_BASE_URL && new URL(process.env.OPENAI_BASE_URL).origin !== 'https://api.openai.com') {
  throw new Error('Live compatibility tests require the official API; OPENAI_BASE_URL cannot point to a mock or proxy.');
}
const { default: OpenAI, toFile } = await import('openai');
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_ADMIN_API_KEY ? { adminAPIKey: process.env.OPENAI_ADMIN_API_KEY } : {}),
  maxRetries: 0, timeout: 120_000,
  ...(process.env.OPENAI_ORG_ID ? { organization: process.env.OPENAI_ORG_ID } : {}),
  ...(process.env.OPENAI_PROJECT_ID ? { project: process.env.OPENAI_PROJECT_ID } : {}),
});
const results = [];
for (const entry of cases) {
  const started = Date.now();
  const steps = [];
  try {
    await executeScenario(client, entry, fixtures, {
      fixtureDirectory: dirname(resolve(root, fixturePath)), toFile,
      onStep: (step) => steps.push(step),
    });
    results.push({ id: entry.id, status: 'passed', durationMs: Date.now() - started, steps });
    console.log(`PASS ${entry.id}`);
  } catch (error) {
    // API errors may contain request content/secrets. Persist codes/status only.
    results.push({
      id: entry.id, status: 'failed', durationMs: Date.now() - started, steps,
      errors: (error.errors ?? [error]).map((cause) => ({
        name: cause.name, stepId: cause.stepId ?? null, cleanup: cause.cleanup ?? false,
        status: cause.status ?? null,
        ...(cause.assertionPath !== undefined ? { assertion: { path: cause.assertionPath, op: cause.assertionOp } } : {}),
        requestId: cause.request_id ?? null,
      })),
    });
    console.error(`FAIL ${entry.id} (details redacted; HTTP statuses: ${results.at(-1).errors.map((cause) => cause.status ?? 'n/a').join(', ')})`);
  }
}
await writeJSON(`reports/live-${version}.json`, {
  version, fullCoverage: !selection && report.complete, partial: Boolean(selection),
  coverageMissing: report.missing, baselineMissing: report.baselineMissing,
  results, passed: results.filter((result) => result.status === 'passed').length,
  failed: results.filter((result) => result.status === 'failed').length,
});
if (!selection && !report.complete) {
  console.error(`COVERAGE GAP ${version}: ${report.missing.length} missing obligations, ${report.baselineMissing.length} removed baseline APIs. Configured regression tests still ran.`);
  process.exitCode = 1;
}
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
