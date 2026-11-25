import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { root } from '../lib/io.mjs';
import { liveStepName } from '../scripts/responses-summary.mjs';
import { releasePair } from '../scripts/release-watch.mjs';
import { releasesNeedingTests, releaseTestIssue, main as requestReleaseTests } from '../scripts/request-release-tests.mjs';

for (const name of ['ci.yml', 'releases.yml', 'azure-compat-live.yml', 'sdk-release-watch.yml', 'copilot-setup-steps.yml']) {
  test(`${name} is valid GitHub Actions YAML with resolvable job prerequisites and pinned actions`, async () => {
    const document = YAML.parseDocument(await readFile(join(root, '.github', 'workflows', name), 'utf8'), { uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    const workflow = document.toJS();
    assert.ok(workflow.on);
    assert.ok(Object.keys(workflow.jobs).length);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const prerequisite of [job.needs ?? []].flat()) {
        assert.ok(prerequisite in workflow.jobs, `${id} depends on nonexistent ${prerequisite}`);
      }

      for (const step of job.steps) {
        assert.ok(Boolean(step.run) !== Boolean(step.uses), `${id}: step must have either run or uses`);
        if (step.uses) assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/, `${id}: action must be immutable`);
      }
    }
  });
}

test('Azure live workflow is main-only, manual, environment-gated, and authenticates without client secrets', async () => {
  const workflow = YAML.parse(await readFile(join(root, '.github', 'workflows', 'azure-compat-live.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const job = workflow.jobs.live;
  assert.equal(job.environment, 'openai-live');
  assert.equal(job.permissions['id-token'], 'write');
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /inputs\.confirm_paid_tests == true/);
  const login = job.steps.find((step) => step.uses?.startsWith('azure/login@'));
  assert.ok(login);
  assert.equal(login.with.creds, undefined);
  assert.equal(login.with['client-secret'], undefined);
  const artifact = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with.name === 'azure-live-results');
  assert.equal(artifact.with.path, 'reports/azure-live.json');
  const offlineArtifact = job.steps.find((step) => step.with?.name === 'sdk-compatibility-details');
  assert.equal(offlineArtifact.with.path, 'reports/responses-compatibility.json');
  const contractsIndex = job.steps.findIndex((step) => step.run === 'npm run test:responses');
  const loginIndex = job.steps.indexOf(login);
  assert.ok(contractsIndex >= 0 && contractsIndex < loginIndex);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.mode.default, 'configured');
  assert.deepEqual(inputs.mode.options, ['configured', 'responses-core', 'azure-companion']);
  const live = job.steps.find((step) => step.run === 'npm run test:azure:keyvault');
  assert.equal(live.env.AZURE_COMPAT_MODE, '${{ inputs.mode }}');
  assert.equal(live.env.RESPONSES_LIVE_FEATURES, '${{ inputs.responses_features }}');
  assert.equal(inputs.responses_features.default, '');
  assert.equal(live.env.AZURE_COMPANION_FEATURES, '${{ inputs.companion_features }}');
  assert.equal(live.env.AZURE_COMPANION_CHAT_DEPLOYMENT, '${{ inputs.companion_chat_deployment }}');
  assert.equal(job.permissions['actions'], 'read');
  const logs = job.steps.find((step) => step.name === 'Locate live test logs');
  assert.equal(logs.if, "inputs.mode != 'azure-companion'");
  assert.match(logs.run, /GITHUB_RUN_ATTEMPT/);
  assert.ok(logs.run.includes(live.name));
  assert.match(logs.run, /RESPONSES_LIVE_LOG_URL=/);
  const offlineReport = job.steps.find((step) => step.run === 'npm run responses:report');
  assert.equal(offlineReport.env.AZURE_COMPAT_MODE, '${{ inputs.mode }}');
  assert.equal(live.env.COMPAT_SUMMARY_DEFERRED, "${{ inputs.mode != 'azure-companion' }}");
  assert.equal(offlineReport.env.COMPAT_SUMMARY_DEFERRED, live.env.COMPAT_SUMMARY_DEFERRED, 'offline findings follow the issue summary');
  const summary = workflow.jobs.summary;
  assert.equal(summary.needs, 'live');
  assert.match(summary.if, /needs\.live\.result != 'skipped'/);
  assert.match(summary.if, /inputs\.mode != 'azure-companion'/);
  assert.ok(summary.steps.some((step) => step.with?.name === 'sdk-compatibility-details' && step['continue-on-error'] === true));
  assert.deepEqual(summary.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' });
  assert.equal(summary.environment, 'compat-issues', 'summary job must use the issue-token environment, not live secrets');
  const summaryLogin = summary.steps.find((step) => step.uses?.startsWith('azure/login@'));
  assert.equal(summaryLogin.with['allow-no-subscriptions'], true);
  assert.equal(summaryLogin['continue-on-error'], true, 'issue filing must never block the results table');
  const fileStep = summary.steps.find((step) => step.run?.includes('node scripts/responses-summary.mjs'));
  assert.match(fileStep.run, /az keyvault secret show/);
  assert.equal(JSON.stringify(summary).includes('secrets.'), false, 'no GitHub-stored secret is used');
  assert.equal(job.steps.find((step) => step.name === liveStepName)?.run, 'npm run test:azure:keyvault');
  assert.ok(summary.steps.some((step) => step.run?.includes('node scripts/responses-summary.mjs')));
});

test('live workflow swaps in requested SDK versions only after offline contracts and names the run by version pair', async () => {
  const workflow = YAML.parse(await readFile(join(root, '.github', 'workflows', 'azure-compat-live.yml'), 'utf8'));
  assert.match(workflow['run-name'], /openai \$\{\{ inputs\.baseline_version \|\| 'pinned' \}\} vs \$\{\{ inputs\.current_version \|\| 'pinned' \}\}$/);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.baseline_version.default, '');
  assert.equal(inputs.current_version.default, '');
  const steps = workflow.jobs.live.steps;
  const install = steps.findIndex((step) => step.name === 'Install selected SDK versions');
  assert.ok(install > steps.findIndex((step) => step.run === 'npm run responses:report'));
  assert.ok(install < steps.findIndex((step) => step.run === 'npm run test:azure:keyvault'));
  assert.equal(steps[install].env.CURRENT_VERSION, '${{ inputs.current_version }}');
  assert.equal(steps[install].run.includes('${{'), false, 'inputs reach the shell only through env');
  assert.match(steps[install].run, /--no-save/);
});

test('release watcher dispatches responses-core once per newest release pair', async () => {
  const workflow = YAML.parse(await readFile(join(root, '.github', 'workflows', 'sdk-release-watch.yml'), 'utf8'));
  assert.ok(workflow.on.schedule);
  const job = workflow.jobs.dispatch;
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'write' });
  const run = job.steps.find((step) => step.run?.includes('gh workflow run')).run;
  assert.match(run, /azure-compat-live\.yml --ref main -f confirm_paid_tests=true -f mode=responses-core/);
  assert.match(run, /-f baseline_version="\$PREVIOUS" -f current_version="\$LATEST"/);
  assert.match(run, /endswith\(\\"\$title\\"\)/);
  assert.deepEqual(releasePair(['7.45.1', '7.57.0', '7.56.0', '7.58.0-beta.1', '7.9.0'], '7.57.0'),
    { previous: '7.56.0', latest: '7.57.0' });
  assert.throws(() => releasePair(['7.57.0'], '7.57.0'), /No stable release precedes/);
  assert.throws(() => releasePair(['7.56.0'], '7.58.0-beta.1'), /not a stable version/);
});

test('release watcher asks the Copilot coding agent for tests with an App user token from Key Vault, never a stored secret', async () => {
  const workflow = YAML.parse(await readFile(join(root, '.github', 'workflows', 'sdk-release-watch.yml'), 'utf8'));
  const job = workflow.jobs['request-tests'];
  assert.equal(job.environment, 'compat-issues');
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'read', 'id-token': 'write' });
  assert.match(job.if, /RELEASE_TESTS_FROM/);
  assert.equal(JSON.stringify(job).includes('secrets.'), false);
  const step = job.steps.find((entry) => entry.run?.includes('request-release-tests.mjs'));
  assert.equal(step.env.GITHUB_TOKEN, '${{ github.token }}');
  assert.equal(step.env.AZURE_KEYVAULT_NAME, '${{ vars.AZURE_KEYVAULT_NAME }}');
  assert.deepEqual(releasesNeedingTests(['7.62.0', '7.64.0', '7.63.0', '7.65.0-beta.1', '7.65.0'], '7.64.0', '7.63.0'),
    ['7.63.0', '7.64.0']);
  assert.throws(() => releasesNeedingTests(['7.64.0'], '7.64.0', ''), /RELEASE_TESTS_FROM/);
  const issue = releaseTestIssue({ version: '7.64.0', previous: '7.63.0',
    features: [{ id: 'changelog:7.64.0:abc', description: '**api:** add a | b' }] });
  assert.equal(issue.title, 'Add tests for openai 7.64.0');
  assert.ok(issue.body.includes('| `changelog:7.64.0:abc` | **api:** add a \\| b |'));
  assert.ok(issue.body.includes('compare/v7.63.0...v7.64.0'));
  assert.match(issue.body, /Do not set `ALLOW_LIVE_API`/);
});

test('release test requests rotate the App user token only when an issue is created, saving it before use', async () => {
  const events = [];
  const changelog = '## [7.64.0](https://x) (2026-08-03)\n\n### Features\n\n* **api:** add healthcare model IDs\n';
  const fetchImpl = async (url, init = {}) => {
    const auth = init.headers?.authorization ?? init.headers?.Authorization;
    events.push(`${init.method ?? 'GET'} ${url.replace(/\?.*/, '')} ${auth ?? ''}`.trim());
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.startsWith('https://npm.test/')) return json({ 'dist-tags': { latest: '7.64.0' }, versions: { '7.63.0': {}, '7.64.0': {} } });
    if (url.includes('/repos/o/r/issues') && init.method === 'GET') return json(issuesSeen);
    if (url.includes('CHANGELOG.md')) return { ok: true, status: 200, text: async () => changelog, json: async () => changelog };
    if (url.includes('/oauth/access_token')) return json({ access_token: 'user-access', refresh_token: 'refresh-2' });
    return json({ html_url: 'https://github.com/o/r/issues/9' });
  };
  const secrets = {
    getSecret: async (name) => ({ value: `${name}-value` }),
    setSecret: async (name, value) => { events.push(`SAVE ${name}=${value}`); },
  };
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'read-token', ISSUES_APP_CLIENT_ID: 'Iv1', RELEASE_TESTS_FROM: '7.64.0', NPM_REGISTRY: 'https://npm.test', GITHUB_STEP_SUMMARY: '' };
  const log = console.log;
  console.log = () => {};
  let issuesSeen = [{ title: 'Add tests for openai 7.64.0' }];
  try {
    await requestReleaseTests(env, { fetchImpl, secrets });
    assert.equal(events.some((event) => event.includes('oauth') || event.startsWith('SAVE')), false);
    events.length = 0;
    issuesSeen = [];
    await requestReleaseTests(env, { fetchImpl, secrets });
  } finally {
    console.log = log;
  }
  const save = events.indexOf('SAVE copilot-agent-refresh-token=refresh-2');
  const create = events.findIndex((event) => event.startsWith('POST https://api.github.com/repos/o/r/issues'));
  assert.ok(save > -1 && create > save, events.join('\n'));
  assert.match(events[create], /user-access/);
  assert.ok(events.filter((event) => event.includes('api.github.com') && !event.startsWith('POST')).every((event) => event.includes('read-token')));
});

test('release discovery checks Responses offline before drafting updates and fails on unreviewed regressions', async () => {
  const workflow = YAML.parse(await readFile(join(root, '.github', 'workflows', 'releases.yml'), 'utf8'));
  const steps = workflow.jobs.discover.steps;
  const contracts = steps.find((step) => step.id === 'responses');
  assert.equal(contracts.run, 'npm run responses:versions');
  assert.equal(contracts.env.ALLOW_LIVE_API, undefined);
  assert.equal(contracts['continue-on-error'], true);
  assert.ok(steps.some((step) => step.if === "steps.responses.outcome == 'failure'" && step.run === 'exit 1'));
  const draft = steps.find((step) => step.run?.includes('gh pr create'));
  assert.ok(draft.run.includes('compat/responses-matrix.json'));
  assert.ok(draft.run.includes('compat/responses-live.template.json'));
});
