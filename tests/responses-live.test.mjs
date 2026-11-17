import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { readJSON } from '../lib/io.mjs';
import { selectLiveMode, validateLiveConfig, validateLivePrerequisites, runLiveMatrix } from '../lib/azure-live.mjs';
import {
  makeResponsesLiveClients, planResponsesLive, prepareResponsesLive, responsesBuiltinIds, responsesFeatureIds,
  runResponsesBuiltin, runResponsesLiveMatrix,
} from '../lib/responses-live.mjs';
import { responseFixture, responseEvents, responsesTargets, responsesTransport } from '../lib/responses-contract.mjs';
import { main as liveMain, writeLiveReport } from '../scripts/azure-live.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderLiveSummary } from '../lib/compat-summary.mjs';
import { sanitizeServiceMessage } from '../lib/service-diagnostics.mjs';
import { caseLineLinks, liveJobName, liveStepName, main as summaryMain } from '../scripts/responses-summary.mjs';

const config = () => ({
  endpoint: 'https://fixture.openai.azure.com', apiVersion: '2025-04-01-preview',
  azureApiKey: 'offline-azure-key', openaiApiKey: 'offline-openai-key',
  azureDeployments: { responses: 'test-responses' }, openaiModels: { responses: 'test-responses' },
  suites: ['responses'],
  responses: { mode: 'selected', azureApiMode: 'v1', features: ['method:create'] },
});

function liveTransport(SDK, route, { cleanupFails = false, badMethod, deleteStatus = 200, deletionBody } = {}) {
  const deleted = new Set();
  let serial = 0;
  return responsesTransport(SDK, route, (request) => {
    const path = request.url.pathname;
    if (request.method === 'DELETE') {
      if (cleanupFails) return { status: 503, body: { error: { message: 'SECRET-CLEANUP-ERROR' } } };
      deleted.add(path.split('/').at(-1));
      return deleteStatus === 204 ? { status: 204 } : {
        body: deletionBody ?? { id: path.split('/').at(-1), object: 'response.deleted', deleted: true },
      };
    }
    if (path.endsWith('/input_tokens')) return { body: { object: 'response.input_tokens', input_tokens: badMethod === 'method:inputTokens.count' ? 0 : 7 } };
    if (path.endsWith('/compact')) return { body: { object: 'response.compaction', output: badMethod === 'method:compact'
      ? [{ type: 'message', content: [] }] : [{ type: 'compaction', id: 'compact_1', encrypted_content: 'offline' }] } };
    if (path.endsWith('/input_items')) {
      const next = request.url.searchParams.has('after');
      const id = next && badMethod !== 'method:inputItems.list' ? 'input_2' : 'input_1';
      return { body: { object: 'list', data: [{ id, type: 'message', role: 'user', content: [] }], has_more: !next, first_id: id, last_id: id } };
    }
    if (path.endsWith('/cancel')) return { body: responseFixture({
      id: badMethod === 'method:cancel' ? 'wrong-response' : path.split('/').at(-2), status: 'cancelled',
    }) };
    if (request.method === 'GET') return deleted.has(path.split('/').at(-1)) && badMethod !== 'method:delete'
      ? { status: 404, body: { error: { message: 'deleted' } } }
      : { body: responseFixture({ id: badMethod === 'method:retrieve' ? 'wrong-response' : path.split('/').at(-1) }) };
    const body = request.body;
    const response = responseFixture({ id: `resp_live_${++serial}`, ...(body.background ? { status: 'in_progress' } : {}) });
    if (body.text?.format && body.text.format.type !== 'text') response.output[0].content[0].text = '{"value":7}';
    if (body.tools?.[0]?.type === 'function') response.output = [{
      type: 'function_call', id: 'fc_test', call_id: 'call_test', name: body.tools[0].name, arguments: '{"key":"compat"}', status: 'completed',
    }];
    if (body.previous_response_id && typeof body.input === 'string') response.output[0].content[0].text = 'cerulean-bicycle-42';
    return body.stream ? { events: responseEvents(response) } : { body: response };
  });
}

test('all-nine Responses workflow preset expands selection without changing configured routes, models, or method overrides', async () => {
  const original = config();
  original.responses.cases = { 'method:compact': { azure: { ready: true, builtin: true, model: 'dedicated-compaction' } } };
  const snapshot = JSON.stringify(original);
  for (const azureApiMode of ['v1', 'versioned', 'both']) {
    original.responses.azureApiMode = azureApiMode;
    const selected = selectLiveMode(original, { AZURE_COMPAT_MODE: 'responses-core' });
    assert.deepEqual(selected.suites, ['responses']);
    assert.deepEqual([...selected.responses.features].sort(), responsesFeatureIds.filter((id) => id.startsWith('method:')).sort());
    assert.equal(selected.responses.mode, 'selected');
    assert.equal(selected.responses.azureApiMode, azureApiMode);
    assert.equal(selected.responses.cases, original.responses.cases);
    assert.equal(selected.openaiApiKey, original.openaiApiKey);
    assert.equal(selected.azureDeployments, original.azureDeployments);
    assert.deepEqual(planResponsesLive(selected).missing, []);
    assert.equal((await makeResponsesLiveClients(selected)).length, azureApiMode === 'both' ? 6 : 4);
  }
  original.responses.azureApiMode = 'v1';
  assert.equal(JSON.stringify(original), snapshot);
  const narrow = selectLiveMode(original, {
    AZURE_COMPAT_MODE: 'responses-core',
    RESPONSES_LIVE_FEATURES: 'method:delete, method:inputItems.list, method:inputTokens.count',
  });
  assert.deepEqual(narrow.responses.features, ['method:delete', 'method:inputItems.list', 'method:inputTokens.count']);
  assert.deepEqual(planResponsesLive(narrow).missing, []);
  assert.throws(() => planResponsesLive(selectLiveMode(original, {
    AZURE_COMPAT_MODE: 'responses-core', RESPONSES_LIVE_FEATURES: 'method:unknown',
  })));
});

test('all-nine preset executes 36 actual SDK scenarios and reports 9/9 methods without claiming full feature coverage', async () => {
  const selected = selectLiveMode(config(), { AZURE_COMPAT_MODE: 'responses-core' });
  const targets = await makeResponsesLiveClients(selected);
  for (const target of targets) {
    const route = target.provider === 'openai' ? 'openai' : 'azure-v1';
    const transport = liveTransport(target.SDK, route);
    target.client = transport.client;
    target.requests = transport.requests;
  }
  const result = await runResponsesLiveMatrix(selected, targets);
  assert.equal(result.results.length, 36);
  assert.ok(result.results.every((row) => row.status === 'passed'), JSON.stringify(result.results));
  assert.equal(result.complete, false);
  assert.ok(targets.every((target) => target.requests.length === 18));
  const summary = renderLiveSummary({
    live: true, responses: { mode: result.mode, complete: result.complete }, results: result.results,
  });
  assert.match(summary, /9 of 9 core methods passed/);
  assert.match(summary, /complete: false means partial coverage, not a failed test/);
  for (const assertion of ['subsequent retrieve returns HTTP 404', 'cancels the same response ID',
    'requires an encrypted compaction item', 'second input-item page', 'positive integer token count']) {
    assert.ok(summary.includes(assertion), assertion);
  }
});

for (const [name, SDK] of [['baseline', Baseline], ['current', Current]]) {
  for (const route of responsesTargets) {
    test(`${name}/${route}: all live functional adapters run through actual SDK transports`, async (t) => {
      for (const id of responsesBuiltinIds) await t.test(id, async () => {
        const { client, requests } = liveTransport(SDK, route);
        const result = await runResponsesBuiltin({ client, SDK, provider: route === 'openai' ? 'openai' : 'azure' }, id, config());
        assert.equal(result.status, 'passed');
        assert.ok(requests.length > 0);
        if (['method:retrieve', 'method:inputItems.list', 'method:cancel', 'tool:function', 'create:previous_response_id'].includes(id)) {
          assert.equal(requests.at(-1).method, 'DELETE', 'Stored state must be cleaned up');
        }
        if (id === 'method:inputItems.list') assert.ok(requests.some((request) => request.url.searchParams.get('after') === 'input_1'));
      });
    });
  }
  test(`${name}: all six added live selections reject incorrect API behavior and clean up stored state`, async (t) => {
    for (const id of ['method:retrieve', 'method:delete', 'method:cancel', 'method:compact', 'method:inputItems.list', 'method:inputTokens.count']) {
      await t.test(id, async () => {
        const { client, requests } = liveTransport(SDK, 'azure-v1', { badMethod: id });
        await assert.rejects(runResponsesBuiltin({ client, SDK, provider: 'azure' }, id, config()), { name: 'AssertionError' });
        if (['method:retrieve', 'method:cancel', 'method:inputItems.list'].includes(id)) {
          assert.equal(requests.at(-1).method, 'DELETE');
        }
      });
    }
  });
}

test('a successful Responses assertion cannot hide failed cleanup', async () => {
  const { client } = liveTransport(Current, 'azure-v1', { cleanupFails: true });
  await assert.rejects(runResponsesBuiltin({ client, provider: 'azure' }, 'method:retrieve', config()), /cleanup failed/);
});

test('delete accepts documented JSON acknowledgments and empty 204 responses on both SDKs without retrying a deleted resource', async () => {
  for (const SDK of [Baseline, Current]) {
    for (const deleteStatus of [200, 204]) {
      const { client, requests } = liveTransport(SDK, 'azure-v1', { deleteStatus });
      await runResponsesBuiltin({ client, SDK, provider: 'azure' }, 'method:delete', config());
      assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1);
      assert.equal(requests.at(-1).method, 'GET', 'Must verify the deleted response is unavailable');
    }
    for (const deletionBody of [
      { id: 'wrong', object: 'response.deleted', deleted: true },
      { id: 'resp_live_1', object: 'response.deleted', deleted: false },
      { id: 'resp_live_1', object: 'unexpected', deleted: true },
    ]) {
      const { client, requests } = liveTransport(SDK, 'azure-v1', { deletionBody });
      await assert.rejects(runResponsesBuiltin({ client, SDK, provider: 'azure' }, 'method:delete', config()),
        (error) => error.name === 'AssertionError' && error.compatibilityOperation === 'responses.delete');
      assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1);
    }
  }
});

test('Responses diagnostics retain only known operations, codes, parameters, and message hints', async () => {
  for (const [feature, status, message, code, param] of [
    ['method:inputItems.list', 404, 'Unknown request URL: SECRET-URL', 'NotFound', 'SECRET-PARAM'],
    ['method:inputTokens.count', 400, 'input_tokens is not supported for model SECRET-MODEL', 'OperationNotSupported', 'model'],
  ]) {
    const value = config();
    value.responses.features = [feature];
    const { client } = responsesTransport(Current, 'azure-v1', (request) => {
      if (request.method === 'DELETE') return { status: 204 };
      if (request.url.pathname.endsWith('/responses')) return { body: responseFixture() };
      return { status, body: { error: { code, param, message } } };
    });

    test('Azure pagination failure diagnostics identify the second page and retain cleanup without leaking cursor or response IDs', async () => {
      const value = config();
      value.responses.features = ['method:inputItems.list'];
      const { client, requests } = responsesTransport(Current, 'azure-v1', (request) => {
        if (request.method === 'DELETE') return { status: 204 };
        if (request.method === 'POST') return { body: responseFixture() };
        if (request.url.searchParams.has('after')) return {
          status: 404, body: { error: { code: 'NotFound', message: 'Response SECRET-RESPONSE could not be found at SECRET-ENDPOINT' } },
        };
        return { body: { object: 'list', data: [{ id: 'SECRET-CURSOR', type: 'message' }],
          has_more: true, first_id: 'SECRET-CURSOR', last_id: 'SECRET-CURSOR' } };
      });
      const report = await runResponsesLiveMatrix(value, [{
        client, SDK: Current, id: 'azure', provider: 'azure', supported: new Set(value.responses.features),
      }]);
      assert.equal(report.results[0].error.operation, 'responses.inputItems.list.nextPage');
      assert.equal(report.results[0].error.status, 404);
      assert.equal(requests.at(-1).method, 'DELETE');
      assert.doesNotMatch(JSON.stringify(report), /SECRET-/);
    });
    const result = await runResponsesLiveMatrix(value, [{
      client, SDK: Current, id: 'current-azure-v1', provider: 'azure', supported: new Set([feature]),
    }]);
    const row = result.results[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.error.operation, feature.replace('method:', 'responses.'));
    assert.equal(row.error.serviceCode, code);
    assert.equal(row.error.parameter, param === 'model' ? 'model' : undefined);
    assert.ok(row.error.serviceSignals.includes(status === 404 ? 'unknown-request-url' : 'unsupported'));
    assert.doesNotMatch(JSON.stringify(result), /SECRET-/);
    const summary = renderLiveSummary({ live: true, results: [{ ...row, suite: 'responses' }] });
    assert.match(summary, /Where the Responses failures occurred/);
    assert.doesNotMatch(summary, /SECRET-/);
  }
});

function itemsTransport(notFoundCount, { status = 404, message = "Response with id 'resp_SECRET1' not found." } = {}) {
  let lookups = 0;
  return responsesTransport(Current, 'azure-v1', (request) => {
    if (request.method === 'DELETE') return { status: 204 };
    if (request.method === 'POST') return { body: responseFixture({ id: 'resp_SECRET1' }) };
    if (!request.url.searchParams.has('after') && ++lookups <= notFoundCount) return {
      status, headers: { 'apim-request-id': `0eeae89f-638d-4ced-b6ed-64${lookups}e8f72bfef` },
      body: { error: { type: 'invalid_request_error', code: null, message } },
    };
    const next = request.url.searchParams.has('after');
    return { body: { object: 'list', data: [{ id: next ? 'item_2' : 'item_1', type: 'message' }], has_more: !next } };
  });
}
const itemsConfig = () => ({ ...config(), responses: { mode: 'selected', azureApiMode: 'v1', features: ['method:inputItems.list'] } });
const itemsTarget = (client) => [{ client, SDK: Current, id: 'current-azure-v1', provider: 'azure', version: '7.45.1',
  supported: new Set(['method:inputItems.list']) }];

test('a stored response that becomes listable after 404s passes with a read-after-write warning', async () => {
  const { client, requests } = itemsTransport(2);
  const result = await runResponsesLiveMatrix(itemsConfig(), itemsTarget(client), undefined, { readAfterWriteDelayMs: 1 });
  const row = result.results[0];
  assert.equal(row.status, 'passed');
  assert.equal(row.warning.kind, 'read-after-write-delay');
  assert.equal(row.warning.retries, 2);
  assert.equal(row.warning.requestId, '0eeae89f-638d-4ced-b6ed-642e8f72bfef');
  assert.equal(requests.at(-1).method, 'DELETE');
  const summary = renderLiveSummary({ live: true, summaryMode: 'responses-core', results: [{ ...row, suite: 'responses' }] });
  assert.match(summary, /\u{1f7e1} Passed with warning; API read-after-write delay/u);
  assert.doesNotMatch(summary, /\u{1f7e2}|\u{1f534}/u);
  assert.doesNotMatch(JSON.stringify(result) + summary, /SECRET/);
});

test('persistent stored-response 404s and unsupported-model 400s report exact redacted service causes', async () => {
  const { client } = itemsTransport(Infinity);
  const missing = (await runResponsesLiveMatrix(itemsConfig(), itemsTarget(client), undefined,
    { readAfterWriteWindowMs: 5, readAfterWriteDelayMs: 1 })).results[0];
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error.knownCause, 'stored-response-not-found-after-retry');
  assert.equal(missing.error.serviceType, 'invalid_request_error');
  assert.equal(missing.error.serviceMessage, 'Response with id {value} not found.');
  assert.ok(Number.isInteger(missing.error.retriedForMs) && missing.error.retries > 0);

  const value = itemsConfig();
  value.responses.features = ['method:inputTokens.count'];
  const { client: tokens } = responsesTransport(Current, 'azure-v1', () => ({
    status: 400, headers: { 'apim-request-id': 'c57f9837-a864-4f68-8b42-3c1a47d5de7f' },
    body: { error: { type: 'invalid_request_error', message: 'This model is not supported by Responses API.' } },
  }));
  const unsupported = (await runResponsesLiveMatrix(value, [{ ...itemsTarget(tokens)[0], supported: new Set(value.responses.features) }])).results[0];
  assert.equal(unsupported.error.knownCause, 'model-unsupported-for-operation');
  assert.equal(unsupported.error.serviceMessage, 'This model is not supported by Responses API.');
  assert.equal(unsupported.error.requestId, 'c57f9837-a864-4f68-8b42-3c1a47d5de7f');

  const summary = renderLiveSummary({ live: true, summaryMode: 'responses-core',
    links: { logs: 'https://github.com/o/r/actions/runs/1/job/2' },
    results: [missing, unsupported].map((row) => ({ ...row, suite: 'responses' })) });
  assert.match(summary, /\u{1f534} Failed \(HTTP 404\); API issue: stored response not found after retries/u);
  assert.match(summary, /\u{1f534} Failed \(HTTP 400\); API limitation: model not supported for this operation/u);
  assert.match(summary, /Service message: This model is not supported by Responses API\. Request ID: c57f9837-a864-4f68-8b42-3c1a47d5de7f/);
  assert.doesNotMatch(JSON.stringify([missing, unsupported]) + summary, /SECRET|resp_/);
});

test('service messages keep wording but drop identifiers, URLs, quoted values, and configured names', () => {
  assert.equal(sanitizeServiceMessage(
    "Model plainname at https://x.openai.azure.com/a?b=1 for 'q' rejected gpt-6.1-terra resp_abc input_tokens: no.", ['plainname']),
  'Model {value} at {url} for {value} rejected {value} {value} input_tokens: no.');
  assert.equal(sanitizeServiceMessage(undefined), undefined);
  assert.ok(sanitizeServiceMessage('x '.repeat(300)).length <= 200);
});

test('full preflight lists missing fixture IDs and prevents every paid call, including other suites', async () => {
  const value = config();
  value.responses = { mode: 'full', azureApiMode: 'both' };
  const plan = await validateLivePrerequisites(value);
  assert.ok(plan.missing.some((entry) => entry.id === 'tool:mcp' && entry.provider === 'azure'));
  let calls = 0;
  const result = await runResponsesLiveMatrix(value, [{ provider: 'azure' }], async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(result.complete, false);
  assert.ok(result.results.some((entry) => entry.status === 'blocked-before-paid-calls'));
  assert.throws(() => planResponsesLive({ ...value, responses: { ...value.responses, features: ['method:create'] } }), /cannot select a subset/);
});

test('top-level live entry point persists a redacted preflight report without calling other selected suites', async () => {
  const value = config();
  value.suites.unshift('chat');
  value.azureDeployments.chat = 'test-chat';
  value.openaiModels.chat = 'test-chat';
  value.responses = { mode: 'full', azureApiMode: 'v1' };
  const before = {
    fetch: globalThis.fetch, allow: process.env.ALLOW_LIVE_API, exitCode: process.exitCode,
    log: console.log, summary: process.env.GITHUB_STEP_SUMMARY,
  };
  const directory = await mkdtemp(join(tmpdir(), 'compat-summary-'));
  const reportFile = join(directory, 'azure-live.json');
  process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary.md');
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Must not contact inference'); };
  console.log = () => {};
  process.env.ALLOW_LIVE_API = 'true';
  try {
    await liveMain(JSON.stringify(value), { reportFile });
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(requests, 0);
    assert.equal(report.blockedBeforePaidCalls, true);
    assert.equal(report.live, false);
    assert.equal(report.responses.complete, false);
    assert.equal(process.exitCode, 1);
    assert.ok(!JSON.stringify(report).includes(value.azureApiKey));
    const summary = await readFile(process.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, /fixture preflight blocked all paid API calls/);
    assert.match(summary, /No paid API calls: blocked before execution/);
    assert.ok(!summary.includes(value.azureApiKey));
  } finally {
    globalThis.fetch = before.fetch;
    console.log = before.log;
    process.exitCode = before.exitCode;
    if (before.allow === undefined) delete process.env.ALLOW_LIVE_API;
    else process.env.ALLOW_LIVE_API = before.allow;
    if (before.summary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = before.summary;
    await rm(directory, { recursive: true });
  }
});

test('Responses-only selection does not fall through to legacy audio or pretend legacy parity', async () => {
  validateLiveConfig(config());
  const results = await runLiveMatrix(config(), [{ id: 'legacy', provider: 'azure' }], () => { throw new Error('Must not run'); });
  assert.deepEqual(results, []);
  const targets = await makeResponsesLiveClients({ ...config(), responses: { ...config().responses, azureApiMode: 'both' } });
  assert.equal(targets.length, 6);
  assert.ok(targets.every((target) => !target.id.includes('legacy')));
  assert.ok(targets.some((target) => target.id === 'current-azure-versioned'));
  assert.ok(targets.some((target) => target.id === 'baseline-azure-v1'));
});

test('the follow-up summary links each case to its exact outcome line in the finished live step log', async () => {
  const rows = [
    { suite: 'responses', feature: 'method:inputTokens.count', provider: 'azure', client: 'baseline-azure-v1', version: '7.3.0',
      status: 'failed', error: { status: 400, knownCause: 'model-unsupported-for-operation' } },
    { suite: 'responses', feature: 'method:create', provider: 'openai', client: 'current-openai', version: '7.45.1', status: 'passed' },
  ];
  const stamp = (line) => `2026-11-13T02:55:01.0228892Z ${line}`;
  const log = ['\uFEFF' + stamp('##[group]Run npm run test:responses'), stamp('##[endgroup]'),
    stamp('##[group]Run npm run test:azure:keyvault'), stamp('npm run test:azure:keyvault'), stamp('##[endgroup]'),
    stamp('##[group]Azure OpenAI v1 / baseline SDK 7.3.0: Count input tokens'),
    stamp('compat-case-result baseline-azure-v1 method:inputTokens.count: Azure OpenAI v1 / baseline SDK 7.3.0: Count input tokens'),
    stamp('Failed (HTTP 400)'), stamp('##[endgroup]'),
    stamp('compat-case-result current-openai method:create: OpenAI-hosted API / comparison SDK 7.45.1: Create a text response'),
    stamp('Passed')].join('\n');
  const job = 'https://github.com/example/tests/actions/runs/1/job/2';
  const directory = await mkdtemp(join(tmpdir(), 'core-links-'));
  const reportFile = join(directory, 'azure-live.json');
  const summaryFile = join(directory, 'summary.md');
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  try {
    await import('node:fs/promises').then((fs) => fs.writeFile(reportFile, JSON.stringify({ live: true, results: rows })));
    globalThis.fetch = async (url) => new Response(url.endsWith('/logs') ? log : JSON.stringify({ jobs: [{
      id: 2, name: liveJobName, html_url: job, steps: [{ number: 12, name: liveStepName }],
    }] }));
    console.log = () => {};
    await summaryMain({ reportFile, env: {
      GITHUB_REPOSITORY: 'example/tests', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'token', GITHUB_STEP_SUMMARY: summaryFile,
    } });
    const summary = await readFile(summaryFile, 'utf8');
    assert.ok(summary.includes(`(${job}#step:12:6 "`), 'failure links to its outcome line');
    assert.ok(summary.includes('| \u{1f7e2} Passed |'), 'passed cells are not linked');
    assert.ok(!summary.includes(`${job}#step:12:9`));
    assert.ok(summary.trim().split('\n').every((line) => line.startsWith('|')));
    assert.deepEqual(caseLineLinks('no markers', { results: rows }, `${job}#step:12`), {});
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Responses-core persists revision-pinned test links and log links while the job summary stays table-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'core-summary-'));
  const env = {
    AZURE_COMPAT_MODE: 'responses-core', GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
    GITHUB_REPOSITORY: 'example/tests', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
    RESPONSES_LIVE_LOG_URL: 'https://github.com/example/tests/actions/runs/123/job/456#step:12:1',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const before = { log: console.log, exitCode: process.exitCode };
  const logs = [];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  console.log = (text) => logs.push(text);
  try {
    const reportFile = join(directory, 'azure-live.json');
    await writeLiveReport({
      live: true, results: [{ suite: 'responses', feature: 'method:inputTokens.count', provider: 'azure',
        client: 'baseline-azure-v1', version: '7.3.0', status: 'failed',
        error: { status: 400, operation: 'responses.inputTokens.count', serviceSignals: ['unsupported', 'model'] } }],
    }, reportFile);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.summaryMode, 'responses-core');
    assert.equal(report.links.logs, env.RESPONSES_LIVE_LOG_URL);
    const lines = (await readFile(new URL('../lib/responses-live.mjs', import.meta.url), 'utf8')).split('\n');
    const line = Number(report.links.tests['method:inputTokens.count'].split('#L')[1]);
    assert.match(lines[line - 1], /id === 'method:inputTokens.count'/);
    assert.ok(report.links.source.includes(env.GITHUB_SHA));
    const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.ok(summary.trim().split('\n').every((line) => line.startsWith('|')));
    assert.ok(summary.includes(env.RESPONSES_LIVE_LOG_URL));
    assert.ok(logs.some((line) => line.startsWith('::group::Azure OpenAI v1 / baseline SDK 7.3.0: Count input tokens')));
    assert.ok(logs.includes('compat-case-result baseline-azure-v1 method:inputTokens.count: Azure OpenAI v1 / baseline SDK 7.3.0: Count input tokens'));
    assert.ok(logs.some((line) => line.includes('Failed step: Count input tokens')));
    assert.equal(process.exitCode, 1);

    process.env.COMPAT_SUMMARY_DEFERRED = 'true';
    await rm(env.GITHUB_STEP_SUMMARY);
    await writeLiveReport({ live: true, results: [] }, reportFile);
    await assert.rejects(readFile(env.GITHUB_STEP_SUMMARY), { code: 'ENOENT' }, 'summary job writes the deferred table');
  } finally {
    delete process.env.COMPAT_SUMMARY_DEFERRED;
    console.log = before.log;
    process.exitCode = before.exitCode;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported declarations and absent SDK features are separate nonpassing outcomes', async () => {
  const value = config();
  value.responses.cases = { 'method:create': { azure: {
    unsupported: true, reason: 'Dedicated test model does not support this operation.', classification: 'model-limitation',
  } } };
  let calls = 0;
  const result = await runResponsesLiveMatrix(value, [
    { id: 'azure', provider: 'azure', supported: new Set(['method:create']) },
    { id: 'old', provider: 'openai', supported: new Set() },
  ], () => { calls++; });
  assert.equal(calls, 0);
  assert.deepEqual(result.results.map((entry) => entry.status), ['declared-unsupported', 'sdk-unavailable']);
  assert.equal(result.complete, false);
  assert.ok(!JSON.stringify(result).includes('Dedicated test model'));
});

test('reviewed private scenarios require real feature evidence, run assertions, and redact failures', async () => {
  const example = await readJSON('fixtures/responses.example.json');
  const value = config();
  value.responses.features = ['create:instructions'];
  value.responses.cases = { 'create:instructions': {
    azure: example['create:instructions'].azure, openai: example['create:instructions'].azure,
  } };
  assert.deepEqual(planResponsesLive(value).missing, []);
  const { client, requests } = liveTransport(Current, 'azure-v1');
  const target = { client, SDK: Current, id: 'azure', provider: 'azure', supported: new Set(['create:instructions']) };
  const result = await runResponsesLiveMatrix(value, [target]);
  assert.equal(result.results[0].status, 'passed');
  assert.equal(requests[0].body.instructions, 'Reply with only the word compatibility.');
  assert.equal(requests[0].body.model, 'test-responses');
  delete value.responses.cases['create:instructions'].azure.scenario.evidence;
  assert.ok(planResponsesLive(value).missing.some((entry) => entry.status === 'invalid-fixture'));
  const bad = { ...config(), responses: { ...config().responses, features: ['tool:mcp'], cases: {
    'tool:mcp': { azure: { ready: true, scenario: example['create:instructions'].openai } },
  } } };
  assert.ok(planResponsesLive(bad).missing.length);

  const failed = await runResponsesLiveMatrix(config(), [{
    id: 'azure', provider: 'azure', supported: new Set(['method:create']),
  }], async () => { throw Object.assign(new Error('SECRET-RAW-BODY'), {
    status: 403, name: 'SECRET-NAME', compatibilityOperation: 'SECRET-OPERATION',
    error: { code: 'SECRET-CODE', param: 'SECRET-PARAMETER', message: 'SECRET-MESSAGE' },
  }); });
  assert.equal(failed.results[0].error.status, 403);
  assert.ok(!JSON.stringify(failed).includes('SECRET'));
});

test('missing variables, helper misuse, and escaping case paths fail before paid calls', async () => {
  const example = await readJSON('fixtures/responses.example.json');
  const value = config();
  value.responses.caseFile = 'responses.example.json';
  value.responses.features = ['create:instructions'];
  const plan = await prepareResponsesLive(value);
  assert.ok(plan.missing.some((entry) => entry.provider === 'openai'));
  value.responses.caseFile = '../package.json';
  await assert.rejects(prepareResponsesLive(value), /inside fixtures/);
  delete value.responses.caseFile;
  const definition = example['create:instructions'].azure;
  definition.scenario.steps[0].args[0].model = { $env: 'UNCONFIGURED_MODEL' };
  value.responses.cases = { 'create:instructions': { azure: definition, openai: definition } };
  assert.ok(planResponsesLive(value).missing.every((entry) => entry.status === 'invalid-fixture'));
});

test('reviewed live stream errors compare yielded events and typed exceptions without accepting HTTP failures', async () => {
  const definition = {
    ready: true, expectedError: { code: 'offline_error' },
    scenario: {
      steps: [{
        id: 'error_stream', method: 'responses.create', optionsIndex: 1, capture: 'stream',
        args: [{ model: { $env: 'RESPONSES_MODEL' }, input: 'offline', stream: true, store: false }],
        assertions: [{ path: 'types', op: 'includes', value: 'error' }],
      }],
      evidence: { 'event:error': ['error_stream'] },
    },
  };
  const value = config();
  value.responses.features = ['event:error'];
  value.responses.cases = { 'event:error': { azure: definition, openai: definition } };
  for (const SDK of [Baseline, Current]) {
    for (const status of [200, 401]) {
      const { client } = responsesTransport(SDK, 'azure-v1', () => status === 200
        ? { events: [{ type: 'error', sequence_number: 0, code: 'offline_error', message: 'SECRET-ERROR-CONTENT', param: null }] }
        : { status, body: { error: { code: 'offline_error', type: 'error', message: 'SECRET-ERROR-CONTENT' } } });
      const result = await runResponsesLiveMatrix(value, [{
        client, SDK, id: 'azure', provider: 'azure', supported: new Set(['event:error']),
      }]);
      assert.equal(result.results[0].status, status === 200 ? 'passed' : 'failed');
      assert.ok(!JSON.stringify(result).includes('SECRET'));
    }
  }
});
