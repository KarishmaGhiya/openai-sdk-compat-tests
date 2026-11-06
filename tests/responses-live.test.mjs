import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { readJSON } from '../lib/io.mjs';
import { validateLiveConfig, validateLivePrerequisites, runLiveMatrix } from '../lib/azure-live.mjs';
import {
  makeResponsesLiveClients, planResponsesLive, prepareResponsesLive, responsesBuiltinIds,
  runResponsesBuiltin, runResponsesLiveMatrix,
} from '../lib/responses-live.mjs';
import { responseFixture, responseEvents, responsesTargets, responsesTransport } from '../lib/responses-contract.mjs';
import { main as liveMain } from '../scripts/azure-live.mjs';

const config = () => ({
  endpoint: 'https://fixture.openai.azure.com', apiVersion: '2025-04-01-preview',
  azureApiKey: 'offline-azure-key', openaiApiKey: 'offline-openai-key',
  azureDeployments: { responses: 'test-responses' }, openaiModels: { responses: 'test-responses' },
  suites: ['responses'],
  responses: { mode: 'selected', azureApiMode: 'v1', features: ['method:create'] },
});

function liveTransport(SDK, route, { cleanupFails = false } = {}) {
  const deleted = new Set();
  let serial = 0;
  return responsesTransport(SDK, route, (request) => {
    const path = request.url.pathname;
    if (request.method === 'DELETE') {
      if (cleanupFails) return { status: 503, body: { error: { message: 'SECRET-CLEANUP-ERROR' } } };
      deleted.add(path.split('/').at(-1));
      return { status: 204 };
    }
    if (path.endsWith('/input_tokens')) return { body: { object: 'response.input_tokens', input_tokens: 7 } };
    if (path.endsWith('/compact')) return { body: { object: 'response.compaction', output: [{ type: 'compaction', id: 'compact_1', encrypted_content: 'offline' }] } };
    if (path.endsWith('/input_items')) {
      const next = request.url.searchParams.has('after');
      const id = next ? 'input_2' : 'input_1';
      return { body: { object: 'list', data: [{ id, type: 'message', role: 'user', content: [] }], has_more: !next, first_id: id, last_id: id } };
    }
    if (path.endsWith('/cancel')) return { body: responseFixture({ status: 'cancelled' }) };
    if (request.method === 'GET') return deleted.has(path.split('/').at(-1))
      ? { status: 404, body: { error: { message: 'deleted' } } }
      : { body: responseFixture({ id: path.split('/').at(-1) }) };
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
}

test('a successful Responses assertion cannot hide failed cleanup', async () => {
  const { client } = liveTransport(Current, 'azure-v1', { cleanupFails: true });
  await assert.rejects(runResponsesBuiltin({ client, provider: 'azure' }, 'method:retrieve', config()), /cleanup failed/);
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
  const before = { fetch: globalThis.fetch, allow: process.env.ALLOW_LIVE_API, exitCode: process.exitCode, log: console.log };
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Must not contact inference'); };
  console.log = () => {};
  process.env.ALLOW_LIVE_API = 'true';
  try {
    await liveMain(JSON.stringify(value));
    const report = await readJSON('reports/azure-live.json');
    assert.equal(requests, 0);
    assert.equal(report.blockedBeforePaidCalls, true);
    assert.equal(report.live, false);
    assert.equal(report.responses.complete, false);
    assert.equal(process.exitCode, 1);
    assert.ok(!JSON.stringify(report).includes(value.azureApiKey));
  } finally {
    globalThis.fetch = before.fetch;
    console.log = before.log;
    process.exitCode = before.exitCode;
    if (before.allow === undefined) delete process.env.ALLOW_LIVE_API;
    else process.env.ALLOW_LIVE_API = before.allow;
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
  }], async () => { throw Object.assign(new Error('SECRET-RAW-BODY'), { status: 403, name: 'SECRET-NAME' }); });
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
