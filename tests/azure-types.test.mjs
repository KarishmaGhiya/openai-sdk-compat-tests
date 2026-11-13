import { test } from 'node:test';
import assert from 'node:assert/strict';
import { azureExtensionFields, compileAzureProbe, probeAzureTypes } from '../lib/azure-types.mjs';

for (const packageName of ['openai', 'openai-current']) {
  test(`${packageName}: measure every Azure augmentation field before and after the documented import`, async () => {
    const fields = await azureExtensionFields();
    const results = await probeAzureTypes(packageName);
    assert.equal(results.length, fields.length);
    assert.ok(fields.some((entry) => entry.type === 'ChatCompletionCreateParamsNonStreaming' && entry.field === 'data_sources'));
    assert.ok(fields.some((entry) => entry.type === 'UploadPart' && entry.field === 'azure_block_id'));
    assert.deepEqual(results.filter((entry) => !entry.withAzureTypes), [], 'Azure companion does not patch these public types');
    assert.deepEqual(results.filter((entry) => !entry.callSite.withAzureTypes).map((entry) => `${entry.type}.${entry.field}`),
      ['UploadPart.azure_block_id'], 'Known root-export versus actual upload method typing gap; review new gaps');
    assert.ok(results.every((entry) => !entry.callSite.native));
  });

  test(`${packageName}: Azure On Your Data is checked at the actual chat API call site`, () => {
    const source = `
      import { AzureOpenAI } from 'openai';
      declare const client: AzureOpenAI;
      client.chat.completions.create({
        model: 'deployment',
        messages: [{ role: 'user', content: 'fixture' }],
        data_sources: [{
          type: 'azure_search',
          parameters: { endpoint: 'https://search.search.windows.net', index_name: 'fixture', authentication: { type: 'system_assigned_managed_identity' } }
        }]
      });
    `;
    const before = compileAzureProbe(packageName, source);
    assert.ok(before.length > 0, 'If native support was added, update the gap classification');
    assert.deepEqual(compileAzureProbe(packageName, source, true), []);
  });

  test(`${packageName}: legacy enhancements remain an untyped Azure request field even with the companion`, () => {
    const source = `
      import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/index';
      type Enhancements = ChatCompletionCreateParamsNonStreaming['enhancements'];
    `;
    for (const augmented of [false, true]) {
      const diagnostics = compileAzureProbe(packageName, source, augmented);
      assert.ok(diagnostics.some((entry) => entry.code === 2339 && entry.message.includes('enhancements')));
      assert.ok(diagnostics.every((entry) => entry.code === 2339));
    }
  });
}
