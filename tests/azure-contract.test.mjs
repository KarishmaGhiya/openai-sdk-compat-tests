import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { OpenAIClient } from 'azure-openai-legacy';
import { apiVersion, azureEndpoint, chatResponse, contracts, deployment, fakeKey, legacyTransport, messages, modernTransport } from '../lib/azure-contract.mjs';
import { readJSON } from '../lib/io.mjs';
import { toLegacyDataSource } from '../lib/azure-live.mjs';

test('all public legacy Azure client operations have executable migration contracts', async () => {
  const cases = await readJSON('compat/azure-migrations.json');
  const methods = Object.getOwnPropertyNames(OpenAIClient.prototype)
    .filter((name) => name !== 'constructor' && name !== 'setModel').sort();
  assert.deepEqual(cases.map((entry) => entry.legacy).sort(), methods);
  const contracts_ = new Set([...Object.keys(contracts), 'chat-stream', 'completions-stream', 'transcription', 'translation']);
  for (const entry of cases) assert.ok(contracts_.has(entry.contract), entry.legacy);
});

for (const [label, SDK] of [['baseline', Baseline], ['current', Current]]) {
  for (const [name, contract] of Object.entries(contracts)) {
    test(`${label}: legacy ${name} and AzureOpenAI send equivalent migrated requests`, async () => {
      const legacy = legacyTransport(contract.response);
      const modern = modernTransport(SDK, contract.response);
      const old = await contract.legacy(legacy.client);
      const current = await contract.modern(modern.client);
      assert.equal(legacy.requests.length, 1);
      assert.equal(modern.requests.length, 1);
      for (const request of [legacy.requests[0], modern.requests[0]]) {
        assert.equal(request.url.pathname, `/openai/deployments/${deployment}${contract.suffix}`);
        assert.equal(request.url.searchParams.get('api-version'), apiVersion);
        assert.equal(request.headers['api-key'], fakeKey);
        assert.equal(request.headers.authorization, undefined);
      }
      const { model, encoding_format, ...newBody } = modern.requests[0].body;
      assert.equal(model, deployment);
      assert.deepEqual(newBody, legacy.requests[0].body);
      if (name === 'embeddings') {
        assert.equal(encoding_format, 'float');
        assert.deepEqual(old.data[0].embedding, current.data[0].embedding);
        assert.equal(old.usage.totalTokens, current.usage.total_tokens);
      } else if (name === 'chat') {
        assert.equal(old.choices[0].message.content, current.choices[0].message.content);
        assert.equal(old.choices[0].finishReason, current.choices[0].finish_reason);
        assert.deepEqual(old.choices[0].contentFilterResults, { hate: { filtered: false, severity: 'safe' } });
        assert.deepEqual(current.choices[0].content_filter_results, chatResponse.choices[0].content_filter_results);
        assert.deepEqual(current.choices[0].message.context, chatResponse.choices[0].message.context);
        assert.equal(old.usage.totalTokens, current.usage.total_tokens);
      } else if (name === 'images') {
        assert.equal(old.data[0].url, current.data[0].url);
      } else {
        assert.equal(old.choices[0].text, current.choices[0].text);
      }
    });
  }

  for (const [kind, legacyMethod, path] of [
    ['chat', 'streamChatCompletions', 'chat.completions'],
    ['completions', 'streamCompletions', 'completions'],
  ]) {
    test(`${label}: ${legacyMethod} and stream:true preserve streamed content`, async () => {
      const event = kind === 'chat'
        ? { id: 'chat-stream', object: 'chat.completion.chunk', created: 1, model: deployment, choices: [{ index: 0, delta: { role: 'assistant', content: 'compatibility' }, finish_reason: null }] }
        : { id: 'completion-stream', object: 'text_completion', created: 1, model: deployment, choices: [{ index: 0, text: 'compatibility', finish_reason: null, logprobs: null }] };
      const sse = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
      const legacy = legacyTransport(sse, { stream: true });
      const modern = modernTransport(SDK, sse, { stream: true });
      const oldStream = await legacy.client[legacyMethod](deployment, kind === 'chat' ? messages : ['Say compatibility.']);
      const resource = kind === 'chat' ? modern.client.chat.completions : modern.client.completions;
      const newStream = await resource.create({ model: deployment, ...(kind === 'chat' ? { messages } : { prompt: ['Say compatibility.'] }), stream: true });
      const oldEvents = [];
      const newEvents = [];
      for await (const chunk of oldStream) oldEvents.push(chunk);
      for await (const chunk of newStream) newEvents.push(chunk);
      const content = (chunk) => kind === 'chat' ? chunk.choices[0].delta.content : chunk.choices[0].text;
      assert.equal(oldEvents.map(content).join(''), 'compatibility');
      assert.equal(newEvents.map(content).join(''), 'compatibility');
      assert.equal(modern.requests[0].body.stream, true, path);
    });
  }

  for (const [oldMethod, resource, suffix] of [
    ['getAudioTranscription', 'transcriptions', 'transcriptions'],
    ['getAudioTranslation', 'translations', 'translations'],
  ]) {
    test(`${label}: ${oldMethod} migrates byte input to a named multipart file`, async () => {
      const bytes = new Uint8Array([82, 73, 70, 70]);
      const response = { text: 'compatibility' };
      const legacy = legacyTransport(response);
      const modern = modernTransport(SDK, response);
      const old = await legacy.client[oldMethod](deployment, bytes);
      const current = await modern.client.audio[resource].create({ model: deployment, file: await SDK.toFile(bytes, 'fixture.wav') });
      assert.equal(old.text, current.text);
      for (const request of [legacy.requests[0], modern.requests[0]]) {
        assert.equal(request.url.pathname, `/openai/deployments/${deployment}/audio/${suffix}`);
        assert.equal(request.url.searchParams.get('api-version'), apiVersion);
      }
      const file = modern.requests[0].body.get('file');
      assert.equal(file.name, 'fixture.wav');
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
      assert.match(legacy.requests[0].headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.equal(typeof legacy.requests[0].body, 'function', 'legacy transport should provide the encoded multipart body stream');
    });
  }

  test(`${label}: Azure On Your Data request and filter/citation response metadata survive transport`, async () => {
    const modern = modernTransport(SDK, chatResponse);
    const legacy = legacyTransport(chatResponse);
    const dataSources = [{ type: 'azure_search', parameters: { endpoint: 'https://search.search.windows.net', index_name: 'fixture', authentication: { type: 'system_assigned_managed_identity' } } }];
    const result = await contracts.chat.modern(modern.client, { data_sources: dataSources, enhancements: { ocr: { enabled: true } } });
    await contracts.chat.legacy(legacy.client, { azureExtensionOptions: { extensions: dataSources.map(toLegacyDataSource), enhancements: { ocr: { enabled: true } } } });
    assert.deepEqual(modern.requests[0].body.data_sources, legacy.requests[0].body.data_sources);
    assert.deepEqual(modern.requests[0].body.enhancements, legacy.requests[0].body.enhancements);
    assert.deepEqual(modern.requests[0].body.data_sources, dataSources);
    assert.deepEqual(modern.requests[0].body.enhancements, { ocr: { enabled: true } });
    assert.deepEqual(result.prompt_filter_results, chatResponse.prompt_filter_results);
    assert.equal(result.choices[0].message.context.citations[0].title, 'fixture');
  });

  test(`${label}: legacy sampling, tool, function, and JSON response options retain their wire names after migration`, async () => {
    const legacy = legacyTransport(chatResponse);
    const modern = modernTransport(SDK, chatResponse);
    const oldOptions = {
      maxTokens: 32, temperature: 0, topP: 0.9, logitBias: { '42': 1 },
      user: 'compat-fixture', n: 1, stop: ['END'], presencePenalty: 0.2, frequencyPenalty: 0.3,
      seed: 7, responseFormat: { type: 'json_object' },
      functions: [{ name: 'lookup', parameters: { type: 'object', properties: {} } }],
      functionCall: 'auto',
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      toolChoice: 'auto',
    };
    const newOptions = {
      max_tokens: 32, temperature: 0, top_p: 0.9, logit_bias: { '42': 1 },
      user: 'compat-fixture', n: 1, stop: ['END'], presence_penalty: 0.2, frequency_penalty: 0.3,
      seed: 7, response_format: { type: 'json_object' },
      functions: oldOptions.functions, function_call: 'auto', tools: oldOptions.tools, tool_choice: 'auto',
    };
    // This is a serialization fixture, not a claim that every service accepts these options together.
    await contracts.chat.legacy(legacy.client, oldOptions);
    await contracts.chat.modern(modern.client, newOptions);
    const { model, ...body } = modern.requests[0].body;
    assert.equal(model, deployment);
    assert.deepEqual(body, legacy.requests[0].body);
  });

  test(`${label}: Entra credentials use Authorization instead of api-key on both clients`, async () => {
    const credential = { async getToken() { return { token: 'offline-entra-token', expiresOnTimestamp: Date.now() + 3600_000 }; } };
    const legacy = legacyTransport(contracts.embeddings.response, { credential });
    const modern = modernTransport(SDK, contracts.embeddings.response, { tokenProvider: async () => 'offline-entra-token' });
    await contracts.embeddings.legacy(legacy.client);
    await contracts.embeddings.modern(modern.client);
    for (const request of [legacy.requests[0], modern.requests[0]]) {
      assert.equal(request.headers.authorization, 'Bearer offline-entra-token');
      assert.equal(request.headers['api-key'], undefined);
    }
  });

  test(`${label}: AzureOpenAI rejects ambiguous key plus Entra authentication`, () => {
    assert.throws(() => new SDK.AzureOpenAI({
      endpoint: azureEndpoint, apiVersion, apiKey: fakeKey, azureADTokenProvider: async () => 'offline-token',
    }), /mutually exclusive/);
  });

  test(`${label}: Azure server errors fail rather than being counted as compatible`, async () => {
    const modern = modernTransport(SDK, { error: { code: 'DeploymentNotFound', message: 'fixture error' } }, { status: 404 });
    await assert.rejects(contracts.embeddings.modern(modern.client), (error) => {
      assert.equal(error.status, 404);
      return true;
    });
    assert.equal(modern.requests.length, 1);
  });
}
