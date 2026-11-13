import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companionCases, companionEvidence, prepareCompanionLive, runCompanionLiveMatrix } from '../lib/azure-companion-live.mjs';
import { makeLiveClients, selectLiveMode, validateLiveConfig, validateLivePrerequisites } from '../lib/azure-live.mjs';
import { withKeyVaultConfig } from '../lib/azure-keyvault.mjs';
import { renderLiveSummary } from '../lib/compat-summary.mjs';
import { main } from '../scripts/azure-live.mjs';
import { root } from '../lib/io.mjs';
import { readFile, writeFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const config = (features = ['chat', 'chat-stream']) => ({
  endpoint: 'https://fixture.openai.azure.com', apiVersion: '2024-10-21',
  azureApiKey: 'PRIVATE-KEY', azureDeployments: { chat: 'test-chat', completions: 'test-text', images: 'test-image' },
  suites: ['azure-companion'], azureCompanion: { features, groundingPrompt: 'PRIVATE-GROUNDING-PROMPT' },
  dataSources: [{ type: 'azure_search', parameters: {
    endpoint: 'https://fixture.search.windows.net', index_name: 'PRIVATE-INDEX',
    authentication: { type: 'api_key', key: 'PRIVATE-SEARCH-KEY' },
  } }],
});
const filters = { hate: { filtered: false, severity: 'safe' } };
const prompt = [{ prompt_index: 0, content_filter_results: filters }];
const context = { citations: [{ content: 'PRIVATE-CITATION', title: 'PRIVATE-TITLE' }], intent: 'PRIVATE-INTENT' };
const json = (body, status = 200) => Response.json(body, { status });
const sse = (events, leaveOpen = false) => {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  return new Response(leaveOpen ? new ReadableStream({
    start(controller) {
      for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
    },
  }) : text, { headers: { 'content-type': 'text/event-stream' } });
};

function transport({ omitFilters = false, rejectPart = false, rejectCancel = false, missingCitations = false, rejectChat = false, missingFinish = false } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    requests.push({ url: new URL(url), init, body });
    if (path.endsWith('/chat/completions')) {
      if (rejectChat) return json({ error: { message: 'PRIVATE-ERROR' } }, 400);
      const metadata = omitFilters ? {} : { prompt_filter_results: prompt };
      const choiceMetadata = omitFilters ? {} : { content_filter_results: filters };
      if (body.stream) return sse([
        { id: 'chat-test', object: 'chat.completion.chunk', ...metadata, choices: [] },
        { id: 'chat-test', object: 'chat.completion.chunk', choices: [
          { index: 0, delta: { content: 'PRIVATE-OUTPUT', ...(body.data_sources ? { context: missingCitations ? { citations: [] } : context } : {}) }, finish_reason: null },
        ] },
        { id: 'chat-test', object: 'chat.completion.chunk', choices: [
          { index: 0, delta: {}, finish_reason: missingFinish ? undefined : 'stop', ...choiceMetadata },
        ] },
      ]);
      return json({ id: 'chat-test', object: 'chat.completion', ...metadata, choices: [
        { index: 0, message: { role: 'assistant', content: 'PRIVATE-OUTPUT', ...(body.data_sources ? { context: missingCitations ? { citations: [] } : context } : {}) },
          finish_reason: 'stop', ...choiceMetadata },
      ] });
    }
    if (path.endsWith('/completions')) return json({
      id: 'completion-test', object: 'text_completion', prompt_filter_results: prompt,
      choices: [{ index: 0, text: 'PRIVATE-OUTPUT', content_filter_results: filters, finish_reason: 'stop' }],
    });
    if (path.endsWith('/images/generations')) return json({
      created: 1, data: [{ url: 'https://private.invalid/image' }],
      prompt_filter_results: prompt, content_filter_results: [filters],
    });
    if (path.endsWith('/uploads')) return json({ id: 'upload-test', object: 'upload', status: 'pending', bytes: body.bytes });
    if (path.endsWith('/uploads/upload-test/parts')) return rejectPart
      ? json({ error: { message: 'PRIVATE-ERROR' } }, 400)
      : json({ id: 'part-test', object: 'upload.part', upload_id: 'upload-test', azure_block_id: 'PRIVATE-BLOCK-ID' });
    if (path.endsWith('/uploads/upload-test/cancel')) return rejectCancel
      ? json({ error: { message: 'PRIVATE-ERROR' } }, 500)
      : json({ id: 'upload-test', object: 'upload', status: 'cancelled' });
    throw new Error('Unexpected request');
  };
  return { requests, fetch };
}

test('stable companion scenarios execute actual augmented SDK APIs for every declared Azure field on both SDKs', async () => {
  const input = config(Object.keys(companionCases));
  const mock = transport();
  const report = await runCompanionLiveMatrix(input, { fetch: mock.fetch });
  assert.equal(report.independentRuntime, false);
  assert.equal(report.results.length, 14);
  assert.deepEqual(report.unselectedFields, []);
  assert.deepEqual(report.fieldCoverage, { inventoried: 13, selected: 13, verifiedOnBothSDKs: 13, complete: true });
  assert.ok(report.results.every((row) => row.status === 'passed'), JSON.stringify(report.results));
  for (const entry of report.packages) {
    assert.equal(entry.fields.length, 13);
    assert.deepEqual(entry.fields.filter((field) => !field.callSite.withAzureTypes).map((field) => field.type), ['UploadPart']);
  }
  for (const row of report.results) {
    assert.ok(row.fields.every((field) => field.status === 'preserved' && field.wireObservations === field.sdkObservations));
    if (row.feature === 'upload-parts') {
      assert.equal(row.fields[0].declaredWithAzureTypes, true);
      assert.equal(row.fields[0].withAzureTypes, false);
    }
  }
  assert.equal(mock.requests.length, 18);
  for (const { url, init, body } of mock.requests) {
    assert.equal(url.host, 'fixture.openai.azure.com');
    assert.equal(url.searchParams.get('api-version'), input.apiVersion);
    assert.equal(new Headers(init.headers).get('api-key'), input.azureApiKey);
    if (url.pathname.endsWith('/chat/completions')) {
      assert.equal(body.max_completion_tokens, 128);
      assert.equal(body.max_tokens, undefined);
      if (body.data_sources) assert.deepEqual(body.data_sources, input.dataSources);
    }
    if (url.pathname.endsWith('/parts')) assert.ok(body instanceof FormData);
  }
  assert.equal(mock.requests.filter(({ url }) => url.pathname.endsWith('/cancel')).length, 2);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-|fixture\.openai|fixture\.search|private\.invalid/);
  const summary = renderLiveSummary({ live: true, companion: report, results: report.results });
  assert.match(summary, /All 14 selected live cases passed/);
  assert.match(summary, /actual client-call typing gap|Actual call sites still untyped/);
  assert.match(summary, /not a second HTTP client/);
  assert.doesNotMatch(summary, /PRIVATE-|core methods passed/);
});

test('selected live companion cases remain partial and absent Azure metadata is never called an SDK defect or a pass', async () => {
  const report = await runCompanionLiveMatrix(config(), { fetch: transport({ omitFilters: true }).fetch });
  assert.equal(report.results.length, 4);
  assert.equal(report.unselectedFields.length, 9);
  assert.equal(report.fieldCoverage.complete, false);
  assert.equal(report.fieldCoverage.verifiedOnBothSDKs, 0);
  assert.ok(report.results.every((row) => row.status === 'not-observed'));
  assert.ok(report.results.every((row) => row.fields.every((field) => field.status === 'not-observed-on-wire')));
  const summary = renderLiveSummary({ live: true, companion: report, results: report.results });
  assert.match(summary, /0 passed, 0 failed, and 4 were not passed or not run/);
  assert.match(summary, /service\/model support unverified, not an SDK loss/);
  assert.match(summary, /Fields outside this selected live run \| 9/);
  assert.doesNotMatch(summary, /All \d+ selected live cases passed/);
});

test('raw streaming evidence stops at DONE even when Azure leaves the connection open and chunks split CRLF', { timeout: 5000 }, async () => {
  const evidence = companionEvidence('chat-stream');
  const response = await evidence.fetch(async () => sse([{ prompt_filter_results: prompt, choices: [] }], true))('https://fixture.invalid', {});
  evidence.observe('ChatCompletionChunk.prompt_filter_results', prompt);
  const finish = evidence.finish([]);
  response.body.cancel().catch(() => {});
  assert.equal((await finish).find((field) => field.id === 'ChatCompletionChunk.prompt_filter_results').status, 'preserved');
});

test('field evidence distinguishes SDK data loss, alteration, unexpected fields, and unreadable wire evidence', async () => {
  const id = 'ChatCompletion.prompt_filter_results';
  for (const [raw, decoded, expected] of [
    [prompt, prompt, 'preserved'], [prompt, undefined, 'runtime-mismatch'],
    [prompt, [{ changed: true }], 'runtime-mismatch'], [undefined, prompt, 'runtime-mismatch'],
  ]) {
    const evidence = companionEvidence('chat');
    await evidence.fetch(async () => json({ prompt_filter_results: raw }))('https://fixture.invalid', {});
    evidence.observe(id, decoded);
    const result = await evidence.finish([]);
    assert.equal(result.find((field) => field.id === id).status, expected);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
  }
  const evidence = companionEvidence('chat');
  await evidence.fetch(async () => new Response('malformed'))('https://fixture.invalid', {});
  assert.ok((await evidence.finish([])).every((field) => field.status === 'wire-evidence-unavailable'));
});

test('companion preflight checks every selected resource before issuing paid calls', async () => {
  const valid = config();
  assert.equal(validateLiveConfig(valid), valid);
  assert.deepEqual(makeLiveClients(valid), [], 'must not construct legacy/OpenAI-hosted clients for companion-only runs');
  for (const input of [
    { ...valid, azureCompanion: { features: [] } },
    { ...valid, azureCompanion: { features: ['chat', 'chat'] } },
    { ...valid, azureCompanion: { features: ['unknown'] } },
    { ...valid, azureCompanion: { features: ['chat'], maxTokens: 0 } },
    { ...valid, azureCompanion: { features: ['chat'], tokenParameter: 'unknown' } },
    { ...valid, azureCompanion: { features: ['chat', 'images'] }, azureDeployments: { chat: 'test' } },
    { ...valid, azureCompanion: { features: ['chat', 'grounding'] }, dataSources: [] },
    { ...valid, azureCompanion: { features: ['grounding'] } },
  ]) {
    assert.throws(() => validateLiveConfig(input));
    await assert.rejects(validateLivePrerequisites(input));
  }
  const prepared = await prepareCompanionLive(valid);
  assert.equal(prepared.packages.length, 2);
});

test('companion upload probe cancels pending uploads after part failure, and cleanup failures also fail the scenario', async () => {
  for (const options of [{ rejectPart: true }, { rejectCancel: true }]) {
    const mock = transport(options);
    const report = await runCompanionLiveMatrix(config(['upload-parts']), { fetch: mock.fetch });
    assert.equal(mock.requests.length, 6, 'one create, part, and cancel per SDK; no retries');
    assert.equal(mock.requests.filter(({ url }) => url.pathname.endsWith('/cancel')).length, 2);
    assert.ok(report.results.every((row) => row.status === 'failed'));
    assert.ok(report.results.every((row) => row.fields.every((field) => field.status === 'not-evaluated-scenario-failed')));
    assert.ok(report.results.every((row) => row.error.status === (options.rejectPart ? 400 : 500)));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE-ERROR|PRIVATE-BLOCK-ID/);
  }
});

test('HTTP rejection, absent grounding citations, and unfinished streams are not misreported as runtime data loss', async () => {
  for (const [features, options, expected] of [
    [['chat'], { rejectChat: true }, /Failed \(HTTP 400\)/],
    [['grounding', 'grounding-stream'], { missingCitations: true }, /grounding citations not returned/],
    [['chat-stream'], { missingFinish: true }, /missing text or stream finish/],
  ]) {
    const report = await runCompanionLiveMatrix(config(features), { fetch: transport(options).fetch });
    assert.ok(report.results.every((row) => row.status === 'failed'));
    assert.ok(report.results.every((row) => row.fields.every((field) => field.status === 'not-evaluated-scenario-failed')));
    const summary = renderLiveSummary({ live: true, companion: report, results: report.results });
    assert.match(summary, expected);
    assert.match(summary, /Wire-versus-SDK mismatches \(live\) \| 0/);
    assert.doesNotMatch(summary, /PRIVATE-/);
  }
});

test('stable companion uses the Azure Entra scope and bearer header without a key or OpenAI-hosted call', async () => {
  const input = config(['chat']);
  input.azureAuth = 'entra';
  delete input.azureApiKey;
  validateLiveConfig(input);
  let tokenCalls = 0;
  const credential = { async getToken(scopes) {
    tokenCalls++;
    assert.deepEqual(scopes, ['https://cognitiveservices.azure.com/.default']);
    return { token: 'PRIVATE-TOKEN', expiresOnTimestamp: Date.now() + 3_600_000 };
  } };
  const mock = transport();
  const report = await runCompanionLiveMatrix(input, { credential, fetch: mock.fetch });
  assert.ok(report.results.every((row) => row.status === 'passed'));
  assert.ok(tokenCalls > 0);
  for (const { init } of mock.requests) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('api-key'), null);
    assert.equal(headers.get('authorization'), 'Bearer PRIVATE-TOKEN');
  }
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-TOKEN/);
});

test('workflow selection overrides only in-memory suites/deployment and preserves credentials and the Key Vault secret', async () => {
  const original = { ...config(), suites: ['responses'] };
  delete original.azureCompanion;
  const raw = JSON.stringify(original);
  const env = {
    AZURE_COMPAT_MODE: 'azure-companion', AZURE_COMPANION_CHAT_DEPLOYMENT: 'override-chat',
    AZURE_COMPANION_FEATURES: 'chat, chat-stream',
  };
  const selected = selectLiveMode(original, env);
  assert.deepEqual(selected.suites, ['azure-companion']);
  assert.deepEqual(selected.azureCompanion.features, ['chat', 'chat-stream']);
  assert.equal(selected.azureDeployments.chat, 'override-chat');
  assert.equal(original.azureDeployments.chat, 'test-chat');
  assert.equal(JSON.stringify(original), raw);
  assert.equal(selectLiveMode(original, {}), original);
  assert.throws(() => selectLiveMode(original, { AZURE_COMPAT_MODE: 'unknown' }));
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const masked = [];
    await withKeyVaultConfig({
      vaultURL: 'https://fixture.vault.azure.net', secretName: 'config', allowLive: true,
      client: { async getSecret() { return { value: raw }; } }, mask: (value) => masked.push(value),
      run(value) { assert.equal(value, raw); assert.ok(masked.includes('PRIVATE-KEY')); },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('live entrypoint writes redacted companion evidence and summary, and unobserved selected fields fail the run', async () => {
  const file = join(root, 'reports', 'azure-live.json');
  const priorReport = await readFile(file, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; });
  const directory = await mkdtemp(join(tmpdir(), 'azure-companion-summary-'));
  const summaryFile = join(directory, 'summary.md');
  const env = {
    ALLOW_LIVE_API: 'true', GITHUB_STEP_SUMMARY: summaryFile,
    AZURE_COMPAT_MODE: 'azure-companion', AZURE_COMPANION_CHAT_DEPLOYMENT: 'override-chat',
    AZURE_COMPANION_FEATURES: 'chat',
  };
  const previous = {};
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    console.log = () => {};
    for (const omitFilters of [false, true]) {
      process.exitCode = 0;
      const mock = transport({ omitFilters });
      globalThis.fetch = mock.fetch;
      await main(JSON.stringify({ ...config(), suites: ['responses'] }));
      const report = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(report.suites, ['azure-companion']);
      assert.equal(report.versions['@azure/openai'], '2.0.0');
      assert.equal(report.responses, undefined);
      assert.equal(report.companion.independentRuntime, false);
      assert.equal(report.results.length, 2);
      assert.equal(process.exitCode, omitFilters ? 1 : 0);
      assert.equal(mock.requests.length, 2);
      assert.ok(mock.requests.every(({ body }) => body.model === 'override-chat'));
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE-|override-chat/);
    }
    process.env.AZURE_COMPAT_MODE = 'configured';
    const blocked = config(['chat']);
    blocked.suites.push('responses');
    blocked.openaiApiKey = 'PRIVATE-OPENAI-KEY';
    blocked.azureDeployments.responses = 'test-responses';
    blocked.openaiModels = { responses: 'test-responses' };
    blocked.responses = { mode: 'full', azureApiMode: 'v1' };
    let paidCalls = 0;
    globalThis.fetch = () => { paidCalls++; throw new Error('Must not call any service'); };
    await main(JSON.stringify(blocked));
    const report = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(report.blockedBeforePaidCalls, true);
    assert.equal(paidCalls, 0);
    assert.equal(report.companion, undefined);
    assert.equal(process.exitCode, 1);
    const summary = await readFile(summaryFile, 'utf8');
    assert.match(summary, /Stable Azure companion: what gaps did this run find/);
    assert.doesNotMatch(summary, /PRIVATE-|override-chat/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (priorReport === undefined) await unlink(file); else await writeFile(file, priorReport);
    await rm(directory, { recursive: true, force: true });
  }
});
