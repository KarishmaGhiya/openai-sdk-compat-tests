import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { compareVersions, readJSON } from '../lib/io.mjs';
import { compileAzureProbe } from '../lib/azure-types.mjs';
import { responsesCoverage, responsesInventory } from '../lib/responses-inventory.mjs';
import { executeResponsesContract, responseEvents, responseFixture, responsesTargets, responsesTransport } from '../lib/responses-contract.mjs';

const catalog = await readJSON('compat/responses-matrix.json');
for (const [packageName, SDK] of [['openai', Baseline], ['openai-current', Current]]) {
  const inventory = await responsesInventory(packageName);
  const coverage = responsesCoverage(inventory, catalog);
  const behavior = catalog.snapshots.filter((snapshot) => compareVersions(snapshot.version, inventory.version) <= 0).at(-1)?.behaviors;
  test(`${packageName}: every Responses declaration and public feature has reviewed contract coverage`, () => {
    assert.deepEqual(coverage.missing, []);
    assert.deepEqual(coverage.unreviewedSchemas, []);
    assert.deepEqual(coverage.unreviewedRemovals, []);
  });
  test(`${packageName}: every Responses fixture type-checks with and without the Azure companion`, () => {
    const text = coverage.fixtures.filter((fixture) => fixture.type).map((fixture, index) =>
      `const fixture${index}: import("openai/resources/responses/${fixture.module}").${fixture.type} = ${JSON.stringify(fixture.value)};`).join('\n');
    assert.deepEqual(compileAzureProbe(packageName, text), []);
    assert.deepEqual(compileAzureProbe(packageName, text, true), []);
  });
  for (const target of responsesTargets) {
    test(`${packageName}/${target}: execute the complete Responses surface matrix`, async (t) => {
      for (const fixture of coverage.fixtures) {
        await t.test(fixture.id, () => executeResponsesContract(SDK, target, fixture));
      }
    });
    test(`${packageName}/${target}: HTTP failures retain status and never retry`, async () => {
      for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
        const { client, requests } = responsesTransport(SDK, target, () => ({
          status, body: { error: { message: 'offline failure', type: 'compatibility_error', code: 'test_failure' } },
        }));
        await assert.rejects(client.responses.create({ model: 'test', input: 'test' }), (error) => error.status === status);
        assert.equal(requests.length, 1);
      }
    });
    test(`${packageName}/${target}: strict function arguments, refusals, and incomplete output parsing`, async () => {
      const tool = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, strict: true };
      const fn = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'lookup', arguments: '{"key":"compat"}', status: 'completed' };
      const transport = responsesTransport(SDK, target, () => ({ body: responseFixture({ output: [fn] }) }));
      const parsed = await transport.client.responses.parse({ model: 'test', input: 'lookup', tools: [tool] });
      assert.deepEqual(parsed.output[0].parsed_arguments, { key: 'compat' });
      for (const status of ['completed', 'incomplete', 'failed']) {
        const response = responseFixture({ status });
        response.output[0].content = status === 'completed'
          ? [{ type: 'refusal', refusal: 'offline refusal' }]
          : [{ type: 'output_text', text: '{"unfinished":', annotations: [] }];
        const { client } = responsesTransport(SDK, target, () => ({ body: response }));
        const result = await client.responses.parse({
          model: 'test', input: 'test', text: { format: { type: 'json_schema', name: 'test', schema: { type: 'object' } } },
        });
        assert.equal(result.output_parsed, null);
      }
    });
    test(`${packageName}/${target}: structured streaming parses the final object and preserves unknown Azure metadata`, async () => {
      const response = responseFixture({ azure_future_metadata: { diagnostic: 'offline' } });
      response.output[0].content[0].text = '{"ok":true}';
      const { client } = responsesTransport(SDK, target, () => ({ events: responseEvents(response) }));
      const stream = client.responses.stream({
        model: 'test', input: 'test',
        text: { format: { type: 'json_schema', name: 'test', strict: true, schema: {
          type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
        } } },
      });
      const result = await stream.finalResponse();
      assert.ok(['json-parsed', 'not-parsed'].includes(behavior?.rawJsonSchemaStreamParsing), 'Streaming parsing behavior needs explicit review');
      assert.deepEqual(result.output_parsed, behavior.rawJsonSchemaStreamParsing === 'json-parsed' ? { ok: true } : null);
      assert.deepEqual(result.azure_future_metadata, { diagnostic: 'offline' });
    });
  }
  for (const target of ['azure-versioned', 'azure-v1']) {
    test(`${packageName}/${target}: Entra tokens are refreshed per request without key authentication`, async () => {
      let tokens = 0;
      const { client, requests } = responsesTransport(SDK, target, undefined, { tokenProvider: async () => `offline-token-${++tokens}` });
      await client.responses.create({ model: 'test', input: 'test' });
      await client.responses.create({ model: 'test', input: 'test' });
      assert.equal(tokens, 2);
      assert.deepEqual(requests.map((request) => request.headers.authorization), ['Bearer offline-token-1', 'Bearer offline-token-2']);
      assert.ok(requests.every((request) => !('api-key' in request.headers)));
    });
  }
}

test('new fields, unreviewed schema changes, and removed baseline features cannot count as full Responses coverage', async () => {
  const inventory = await responsesInventory('openai');
  const prior = responsesCoverage(inventory, catalog);
  const altered = structuredClone(inventory);
  altered.fixtures.push({ id: 'create:future_feature', kind: 'create' });
  altered.fixtures = altered.fixtures.filter((entry) => entry.id !== 'method:create');
  altered.schema[0].hash = 'unreviewed';
  const result = responsesCoverage(altered, catalog);
  assert.deepEqual(result.missing, ['create:future_feature']);
  assert.ok(result.unreviewedSchemas.length > 0);
  assert.deepEqual(new Set(result.removedBaseline), new Set([...prior.removedBaseline, 'method:create']));
  assert.ok(result.unreviewedRemovals.includes('method:create'));
});
