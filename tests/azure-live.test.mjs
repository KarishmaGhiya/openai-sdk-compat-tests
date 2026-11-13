import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SDK from 'openai-current';
import { chatResponse, contracts, deployment, legacyTransport, modernTransport } from '../lib/azure-contract.mjs';
import { liveSuites, runLiveCase, runLiveMatrix, validateLiveConfig, validateLivePrerequisites } from '../lib/azure-live.mjs';
import { maskValues, validateVaultConfig, withKeyVaultConfig } from '../lib/azure-keyvault.mjs';
import { readJSON, exec, root } from '../lib/io.mjs';
import { renderLiveSummary } from '../lib/compat-summary.mjs';

const config = () => ({
  endpoint: 'https://fixture.openai.azure.com', apiVersion: '2024-10-21',
  azureApiKey: 'offline-azure-key', openaiApiKey: 'offline-openai-key',
  azureDeployments: { chat: deployment, embeddings: deployment },
  openaiModels: { chat: 'test-chat', embeddings: 'test-embeddings' },
  suites: ['chat', 'chat-stream', 'embeddings'],
});

test('live preflight rejects incomplete, ambiguous, or incorrectly routed configuration', () => {
  assert.equal(validateLiveConfig(config()).apiVersion, '2024-10-21');
  for (const overrides of [
    { openaiApiKey: '' }, { azureAuth: 'entra' }, { azureApiKey: '' },
    { endpoint: 'http://fixture.openai.azure.com' }, { endpoint: 'https://api.openai.com' },
    { endpoint: 'https://fixture.openai.azure.com/redirect' },
    { suites: [] }, { suites: ['chat', 'chat'] }, { suites: ['unknown'] },
    { suites: ['transcription'], azureDeployments: { transcription: 'whisper' }, openaiModels: { transcription: 'whisper-1' } },
  ]) assert.throws(() => validateLiveConfig({ ...config(), ...overrides }));
  const entra = config();
  delete entra.azureApiKey;
  entra.azureAuth = 'entra';
  assert.equal(validateLiveConfig(entra).azureAuth, 'entra');
});

test('live suites include all eight legacy operations, plus optional Azure feature cases', () => {
  for (const suite of ['chat', 'chat-stream', 'completions', 'completions-stream', 'embeddings', 'images', 'transcription', 'translation', 'on-your-data', 'azure-filters']) {
    assert.ok(liveSuites.includes(suite));
  }
});

test('audio and grounding prerequisites fail before starting any paid suite', async () => {
  const audio = {
    ...config(), suites: ['chat', 'transcription'],
    azureDeployments: { chat: deployment, transcription: 'whisper' },
    openaiModels: { chat: 'test-chat', transcription: 'whisper-1' },
  };
  await assert.rejects(validateLivePrerequisites({ ...audio, audioFile: '../outside.wav' }), /inside fixtures/);
  await assert.rejects(validateLivePrerequisites({ ...audio, audioFile: 'not-a-wave.mp3' }), /WAV/);
  await assert.rejects(validateLivePrerequisites({ ...audio, audioFile: 'missing-audio-fixture.wav' }), { code: 'ENOENT' });
  for (const dataSources of [[], [null], [{ type: 'elasticsearch', parameters: {} }], [{ type: 'azure_search', parameters: {} }]]) {
    assert.throws(() => validateLiveConfig({ ...config(), suites: ['chat', 'on-your-data'], dataSources }));
  }
});

test('live runner exercises real SDK responses and Azure metadata without external requests', async () => {
  const legacy = legacyTransport(chatResponse);
  const modern = modernTransport(SDK, chatResponse);
  for (const suite of ['chat', 'azure-filters']) {
    await runLiveCase({ client: legacy.client, legacy: true, provider: 'azure' }, suite, config());
    await runLiveCase({ client: modern.client, SDK, provider: 'azure' }, suite, config());
  }
  const embedding = modernTransport(SDK, contracts.embeddings.response);
  const result = await runLiveCase({ client: embedding.client, SDK, provider: 'azure' }, 'embeddings', config());
  assert.equal(result.dimensions, 2);
});

test('live matrix never runs Azure-only suites against OpenAI and redacts service errors', async () => {
  const results = await runLiveMatrix({ suites: ['chat', 'azure-filters'] }, [
    { id: 'legacy', provider: 'azure' }, { id: 'native', provider: 'openai' },
  ], async (target) => {
    if (target.id === 'native') throw Object.assign(new Error('SECRET-RAW-REQUEST-BODY'), { status: 403, name: 'SECRET-ERROR-NAME' });
    return { kind: 'text', nonempty: true };
  });
  assert.equal(results.length, 3);
  assert.equal(results.filter((entry) => entry.status === 'failed').length, 1);
  assert.ok(!JSON.stringify(results).includes('SECRET'));
  assert.equal(results[1].error.status, 403);
  assert.equal(results[1].error.name, 'ServiceError');
});

test('embedding shape regression between Azure SDKs fails without equating different provider models', async () => {
  const clients = [
    { id: 'legacy', provider: 'azure' }, { id: 'azure-new', provider: 'azure' },
    { id: 'openai', provider: 'openai' },
  ];
  const results = await runLiveMatrix({ suites: ['embeddings'] }, clients,
    async (target) => ({ kind: 'embedding', dimensions: target.id === 'legacy' ? 3 : 2 }));
  assert.ok(results.some((entry) => entry.client === 'azure-dimension-parity' && entry.status === 'failed'));
  assert.ok(!results.some((entry) => entry.client === 'openai-dimension-parity'));
});

test('Key Vault values are masked before use and remain in memory', async () => {
  const raw = JSON.stringify(config());
  const masks = [];
  let called = false;
  await withKeyVaultConfig({
    vaultURL: 'https://fixture.vault.azure.net', secretName: 'test-config',
    allowLive: true, client: { async getSecret(name) { assert.equal(name, 'test-config'); return { value: raw }; } },
    mask: (value) => masks.push(value),
    run: async (value) => {
      called = true;
      assert.equal(value, raw);
      assert.ok(masks.includes('offline-azure-key') && masks.includes('offline-openai-key'));
      assert.equal(masks[0], raw);
    },
  });
  assert.ok(called);
});

test('Key Vault masking preserves public report labels while masking private values before execution', async () => {
  const value = { ...config(), azureAuth: 'key', suites: ['responses'],
    azureDeployments: { responses: 'PRIVATE-DEPLOYMENT' }, openaiModels: { responses: 'PRIVATE-MODEL' },
    responses: { mode: 'selected', azureApiMode: 'v1', features: ['method:inputTokens.count'],
      values: { SEARCH_TOKEN: 'PRIVATE-TOKEN' } },
    azureCompanion: { features: ['chat', 'chat-stream'], tokenParameter: 'max_completion_tokens' },
  };
  const raw = JSON.stringify(value);
  const masks = [];
  await withKeyVaultConfig({
    vaultURL: 'https://fixture.vault.azure.net', secretName: 'test-config', allowLive: true,
    client: { async getSecret() { return { value: raw }; } }, mask: (entry) => masks.push(entry),
    run() {
      for (const entry of [raw, value.azureApiKey, value.openaiApiKey, value.endpoint, value.apiVersion,
        'PRIVATE-DEPLOYMENT', 'PRIVATE-MODEL', 'PRIVATE-TOKEN']) assert.ok(masks.includes(entry), entry);
      for (const entry of ['key', 'responses', 'selected', 'v1', 'chat', 'chat-stream', 'max_completion_tokens']) {
        assert.ok(!masks.includes(entry), entry);
      }
      let summary = renderLiveSummary({ live: true, responses: { mode: 'selected' }, results: [{
        suite: 'responses', provider: 'azure', client: 'baseline-azure-v1', version: '7.3.0',
        feature: 'method:inputTokens.count', status: 'failed',
        error: { status: 400, operation: 'responses.inputTokens.count', serviceSignals: ['unsupported', 'model'] },
      }] });
      for (const entry of masks) summary = summary.replaceAll(entry, '***');
      assert.match(summary, /Azure OpenAI v1 \/ baseline SDK 7.3.0/);
      assert.match(summary, /all selected cases/);
      assert.match(summary, /responses.create/);
      assert.doesNotMatch(summary, /PRIVATE-|offline-azure-key|offline-openai-key/);
    },
  });
});

test('public enum values remain masked when used as credentials or private data, and unknown enum values are masked before validation', async () => {
  const value = { ...config(), azureApiKey: 'v1', openaiApiKey: 'responses', azureAuth: 'PRIVATE-AUTH',
    responses: { mode: 'PRIVATE-MODE', azureApiMode: 'PRIVATE-ROUTE', values: { TOKEN: 'selected' } },
    'responses.mode': 'full', dataSources: [{ parameters: { secret: 'key' } }],
  };
  const raw = JSON.stringify(value);
  const masks = [];
  await assert.rejects(withKeyVaultConfig({
    vaultURL: 'https://fixture.vault.azure.net', secretName: 'test-config', allowLive: true,
    client: { async getSecret() { return { value: raw }; } }, mask: (entry) => masks.push(entry),
    run() { assert.fail('Invalid configuration must not run'); },
  }));
  for (const entry of [raw, 'v1', 'responses', 'selected', 'full', 'key', 'PRIVATE-AUTH', 'PRIVATE-MODE', 'PRIVATE-ROUTE']) {
    assert.ok(masks.includes(entry), entry);
  }
  const genericMasks = [];
  maskValues({ mode: 'selected', nested: ['v1'] }, (entry) => genericMasks.push(entry));
  assert.deepEqual(genericMasks, ['selected', 'v1']);
});

test('Key Vault does not retrieve credentials without explicit authorization', async () => {
  let reads = 0;
  await assert.rejects(withKeyVaultConfig({
    allowLive: false, client: { getSecret() { reads++; } },
  }), /Authorize/);
  assert.equal(reads, 0);
  assert.throws(() => validateVaultConfig('https://evil.invalid', 'test'), /Key Vault/);
  assert.throws(() => validateVaultConfig('https://fixture.vault.azure.net', '../secret'), /SECRET_NAME/);
});

test('invalid secret JSON cannot leak its value through the thrown error', async () => {
  await assert.rejects(withKeyVaultConfig({
    vaultURL: 'https://fixture.vault.azure.net', secretName: 'test-config', allowLive: true,
    client: { async getSecret() { return { value: '{"key":"SECRET-VALUE",BROKEN' }; } },
    mask() {}, run() { throw new Error('Must not execute'); },
  }), (error) => {
    assert.match(error.message, /value redacted/);
    assert.ok(!String(error).includes('SECRET-VALUE'));
    return true;
  });
});

test('public example has placeholders only and cannot accidentally run paid tests', async () => {
  const example = await readJSON('compat/azure-live.example.json');
  assert.equal(example.azureApiKey, 'REPLACE-IN-KEY-VAULT-ONLY');
  assert.equal(example.openaiApiKey, 'REPLACE-IN-KEY-VAULT-ONLY');
  await assert.rejects(exec(process.execPath, ['scripts/azure-live.mjs'], {
    cwd: root, env: { ...process.env, ALLOW_LIVE_API: 'false' },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /details redacted/);
    return true;
  });
});
