import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { assertResult, executeScenario, materialize } from '../lib/scenario.mjs';
import { root } from '../lib/io.mjs';

const raw = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const promise = (data) => ({ withResponse: async () => ({ data, response: raw(data) }) });

test('fixture directives preserve environment values and scenario IDs and reject missing prerequisites', async () => {
  const context = { env: { MODEL: 'test-model' }, results: { created: { id: 'id-1' } } };
  const value = await materialize([{ model: { $env: 'MODEL' } }, { $ref: 'created.id' }], context);
  assert.deepEqual(value, [{ model: 'test-model' }, 'id-1']);
  await assert.rejects(materialize({ $env: 'MISSING' }, context), /Missing environment/);
  await assert.rejects(materialize({ $ref: 'unknown.id' }, context), /Missing scenario/);
  await assert.rejects(materialize({ $file: '../secret.txt' }, { fixtureDirectory: root }), /inside the fixture/);
  await assert.rejects(materialize({ $file: 'safe.txt', $env: 'MODEL' }, context), /ambiguous/);
});

test('response assertions reject missing, empty, and malformed data', () => {
  assertResult({ object: 'list', data: [1], score: 1 }, [
    { path: 'object', op: 'equals', value: 'list' },
    { path: 'data', op: 'nonEmpty' }, { path: 'score', op: 'greaterThan', value: 0 },
  ]);
  assert.throws(() => assertResult({}, [{ path: 'id', op: 'exists' }]));
  assert.throws(() => assertResult({ data: [] }, [{ path: 'data', op: 'nonEmpty' }]));
  assert.throws(() => assertResult({ data: {} }, [{ path: 'data', op: 'type', value: 'array' }]));
});

test('cleanup executes after failed assertions, and cleanup failures are not hidden', async () => {
  const calls = [];
  const client = { resources: {
    create() { calls.push('create'); return promise({ id: 'test-id' }); },
    delete(id) { calls.push(`delete:${id}`); throw new Error('cleanup failed'); },
  } };
  const entry = {
    id: 'cleanup',
    steps: [{ id: 'created', method: 'resources.create', args: [], optionsIndex: 0, assertions: [{ path: 'wrong', op: 'exists' }] }],
    cleanup: [{ id: 'deleted', when: 'created.id', method: 'resources.delete', args: [{ $ref: 'created.id' }], optionsIndex: 1, assertions: [{ path: '', op: 'exists' }] }],
  };
  await assert.rejects(executeScenario(client, entry, {}), (error) => {
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(calls, ['create', 'delete:test-id']);
});

test('failed creation does not attempt cleanup of an unknown resource', async () => {
  let deleted = false;
  const entry = {
    id: 'missing',
    steps: [{ id: 'created', method: 'resources.create', args: [], optionsIndex: 0, assertions: [{ path: 'id', op: 'exists' }] }],
    cleanup: [{ id: 'deleted', when: 'created.id', method: 'resources.delete', args: [], optionsIndex: 0, assertions: [{ path: '', op: 'exists' }] }],
  };
  await assert.rejects(executeScenario({
    resources: { create() { throw new Error('failure'); }, delete() { deleted = true; } },
  }, entry, {}));
  assert.equal(deleted, false);
});

test('real SDK transport receives abort options in the correct position for optional query parameters', async () => {
  const requests = [];
  const client = new OpenAI({ apiKey: 'offline-test-key', maxRetries: 0, fetch: async (url, init) => {
    requests.push({ url: String(url), signal: init.signal });
    return raw({ object: 'list', data: [{ id: 'input' }], first_id: 'input', last_id: 'input', has_more: false });
  } });
  const results = await executeScenario(client, {
    id: 'options',
    steps: [{
      id: 'items', method: 'responses.inputItems.list', args: ['resp-test'], optionsIndex: 2,
      assertions: [{ path: 'data', op: 'nonEmpty' }],
    }],
  }, {});
  assert.equal(results.items.data[0].id, 'input');
  assert.match(requests[0].url, /\/responses\/resp-test\/input_items$/);
  assert.ok(requests[0].signal instanceof AbortSignal);
});

test('HTTP failures are not retried or counted as successful coverage', async () => {
  let attempts = 0;
  const client = new OpenAI({ apiKey: 'offline-test-key', fetch: async () => {
    attempts++;
    return raw({ error: { message: 'restricted fixture', type: 'invalid_request_error' } }, 403);
  } });
  await assert.rejects(executeScenario(client, {
    id: 'permission', steps: [{ id: 'list', method: 'models.list', args: [], optionsIndex: 0, assertions: [{ path: 'data', op: 'exists' }] }],
  }, {}));
  assert.equal(attempts, 1);
});

test('real SDK SSE streams are fully consumed and semantic completion is asserted', async () => {
  const sse = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"compatibility"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-test","output":[]}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const client = new OpenAI({
    apiKey: 'offline-test-key',
    fetch: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const result = await executeScenario(client, {
    id: 'stream',
    steps: [{
      id: 'streamed', method: 'responses.create', args: [{ model: 'test-model', input: 'test', stream: true }],
      optionsIndex: 1, capture: 'stream',
      assertions: [{ path: 'types', op: 'includes', value: 'response.completed' }, { path: 'text', op: 'equals', value: 'compatibility' }],
    }],
  }, {});
  assert.equal(result.streamed.events.length, 2);
});

test('binary and HTTP 204 SDK responses are asserted without pretending to be JSON objects', async () => {
  const client = new OpenAI({ apiKey: 'offline-test-key', fetch: async (url) => {
    if (String(url).endsWith('/content')) return new Response('fixture', { headers: { 'Content-Type': 'application/octet-stream' } });
    return raw(null, 204);
  } });
  const result = await executeScenario(client, {
    id: 'binary',
    steps: [
      { id: 'bytes', method: 'files.content', args: ['file-test'], optionsIndex: 1, capture: 'bytes', assertions: [{ path: 'byteLength', op: 'greaterThan', value: 0 }] },
      { id: 'deleted', method: 'responses.delete', args: ['resp-test'], optionsIndex: 1, assertions: [{ path: '', op: 'type', value: 'null' }] },
    ],
  }, {});
  assert.equal(result.bytes.byteLength, 7);
  assert.equal(result.deleted, null);
});

test('hung SDK requests hit the enforced deadline', async () => {
  const entry = {
    id: 'timeout',
    steps: [{ id: 'list', method: 'models.list', args: [], optionsIndex: 0, assertions: [{ path: 'data', op: 'exists' }] }],
  };
  await assert.rejects(executeScenario({ models: { list: () => ({ withResponse: () => new Promise(() => {}) }) } }, entry, {}, { timeout: 10 }), /timeout/);
});
