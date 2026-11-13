import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { OpenAIClient, AzureKeyCredential } from 'azure-openai-legacy';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { AzureCliCredential, getBearerTokenProvider } from '@azure/identity';
import { root } from './io.mjs';
import { prepareCompanionLive, validateCompanionConfig } from './azure-companion-live.mjs';

export const liveSuites = ['chat', 'chat-stream', 'embeddings', 'completions', 'completions-stream', 'images', 'transcription', 'translation', 'on-your-data', 'azure-filters', 'responses', 'azure-companion'];

export function selectLiveMode(config, env = process.env) {
  if (!env.AZURE_COMPAT_MODE || env.AZURE_COMPAT_MODE === 'configured') return config;
  if (env.AZURE_COMPAT_MODE === 'responses-core') return {
    ...config, suites: ['responses'],
    responses: {
      ...config.responses, mode: 'selected',
      features: ['create', 'parse', 'stream', 'retrieve', 'delete', 'cancel', 'compact', 'inputItems.list', 'inputTokens.count']
        .map((method) => `method:${method}`),
    },
  };
  if (env.AZURE_COMPAT_MODE !== 'azure-companion') throw new Error('Unknown live workflow mode.');
  const deployment = env.AZURE_COMPANION_CHAT_DEPLOYMENT?.trim();
  return {
    ...config, suites: ['azure-companion'],
    azureDeployments: { ...config.azureDeployments, ...(deployment ? { chat: deployment } : {}) },
    azureCompanion: {
      ...config.azureCompanion,
      features: (env.AZURE_COMPANION_FEATURES || 'chat,chat-stream').split(',').map((entry) => entry.trim()),
    },
  };
}

export function validateLiveConfig(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Live config must be an object.');
  if (!Array.isArray(value.suites) || !value.suites.length ||
    value.suites.some((suite) => !liveSuites.includes(suite)) || new Set(value.suites).size !== value.suites.length) {
    throw new Error('Choose nonempty distinct supported live suites.');
  }
  const auth = value.azureAuth ?? 'key';
  if (!['key', 'entra'].includes(auth)) throw new Error('azureAuth must be key or entra.');
  if (typeof value.apiVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(value.apiVersion)) {
    throw new Error('Set an explicit supported Azure API version.');
  }
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('Invalid Azure endpoint.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
    !/^[a-z0-9-]+\.openai\.azure\.com$/i.test(endpoint.hostname) ||
    !['', '/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash || endpoint.port) {
    throw new Error('Use an HTTPS Azure OpenAI public-cloud resource root endpoint.');
  }
  if (auth === 'key' && (typeof value.azureApiKey !== 'string' || !value.azureApiKey.trim())) throw new Error('Missing Azure API key.');
  if (auth === 'entra' && value.azureApiKey) throw new Error('Do not supply an API key in Entra mode.');
  if (value.suites.some((suite) => suite !== 'azure-companion') &&
    (typeof value.openaiApiKey !== 'string' || !value.openaiApiKey.trim())) throw new Error('Missing OpenAI API key.');
  const mapping = {
    chat: 'chat', 'chat-stream': 'chat', embeddings: 'embeddings',
    completions: 'completions', 'completions-stream': 'completions',
    images: 'images', transcription: 'transcription', translation: 'translation',
    'on-your-data': 'chat', 'azure-filters': 'chat', responses: 'responses',
  };
  for (const suite of value.suites) {
    if (suite === 'azure-companion') continue;
    for (const provider of ['azureDeployments', 'openaiModels']) {
      if (['on-your-data', 'azure-filters'].includes(suite) && provider === 'openaiModels') continue;
      const name = value[provider]?.[mapping[suite]];
      if (typeof name !== 'string' || !name.trim()) throw new Error(`Missing ${provider}.${mapping[suite]}.`);
    }
  }
  if (value.suites.includes('azure-companion')) validateCompanionConfig(value);
  if (value.suites.some((suite) => ['transcription', 'translation'].includes(suite)) &&
    (typeof value.audioFile !== 'string' || !value.audioFile)) throw new Error('Audio suites require audioFile inside fixtures.');
  if (value.suites.includes('on-your-data') && (!Array.isArray(value.dataSources) || !value.dataSources.length)) {
    throw new Error('on-your-data requires configured dataSources.');
  }
  if (value.suites.includes('on-your-data') && value.dataSources.some((source) =>
    source?.type !== 'azure_search' || !source.parameters?.endpoint || !source.parameters?.index_name)) {
    throw new Error('The live legacy comparison requires Azure Search sources with endpoint and index_name.');
  }
  return value;
}

async function readAudioFixture(config) {
  const fixtures = resolve(root, 'fixtures');
  const file = resolve(fixtures, config.audioFile);
  const rel = relative(fixtures, file);
  if (isAbsolute(config.audioFile) || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ||
    !file.toLowerCase().endsWith('.wav')) throw new Error('Audio requires a relative WAV path inside fixtures.');
  const bytes = await readFile(file);
  if (!bytes.length) throw new Error('Audio fixture must not be empty.');
  return bytes;
}

export async function validateLivePrerequisites(config) {
  validateLiveConfig(config);
  if (config.suites.some((suite) => ['transcription', 'translation'].includes(suite))) {
    await readAudioFixture(config);
  }
  if (config.suites.includes('azure-companion')) await prepareCompanionLive(config);
  if (config.suites.includes('responses')) {
    const { prepareResponsesLive } = await import('./responses-live.mjs');
    return await prepareResponsesLive(config);
  }
}

export function makeLiveClients(config, { credential } = {}) {
  if (!config.suites.some((suite) => !['responses', 'azure-companion'].includes(suite))) return [];
  const auth = config.azureAuth ?? 'key';
  const azureCredential = auth === 'entra' ? credential ?? new AzureCliCredential() : new AzureKeyCredential(config.azureApiKey);
  const azureOptions = {
    endpoint: config.endpoint, apiVersion: config.apiVersion,
    ...(auth === 'entra'
      ? { apiKey: null, azureADTokenProvider: getBearerTokenProvider(azureCredential, 'https://cognitiveservices.azure.com/.default') }
      : { apiKey: config.azureApiKey }),
    timeout: 120_000, maxRetries: 0, logLevel: 'off',
  };
  const clients = [{
    id: 'legacy-azure', provider: 'azure', legacy: true, client: new OpenAIClient(config.endpoint, azureCredential, {
      apiVersion: config.apiVersion, retryOptions: { maxRetries: 0 },
    }),
  }];
  for (const [label, SDK] of [['baseline', Baseline], ['current', Current]]) {
    clients.push({ id: `${label}-azure`, provider: 'azure', SDK, client: new SDK.AzureOpenAI(azureOptions) });
    clients.push({ id: `${label}-openai`, provider: 'openai', SDK, client: new SDK.default({
      apiKey: config.openaiApiKey, baseURL: 'https://api.openai.com/v1',
      timeout: 120_000, maxRetries: 0, logLevel: 'off',
    }) });
  }
  return clients;
}

export async function runLiveCase(target, suite, config) {
  const { client, legacy, provider, SDK } = target;
  const names = provider === 'azure' ? config.azureDeployments : config.openaiModels;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Live case deadline exceeded')), 120_000);
  const signal = controller.signal;
  const request = { signal, timeout: 120_000, maxRetries: 0 };
  const oldOptions = { abortSignal: signal };
  const messages = [{ role: 'user', content: 'Reply with the single word compatibility.' }];
  try {
    if (['chat', 'on-your-data', 'azure-filters'].includes(suite)) {
      const old = {
        ...oldOptions, maxTokens: 32,
        ...(suite === 'on-your-data' ? { azureExtensionOptions: { extensions: config.dataSources.map(toLegacyDataSource) } } : {}),
      };
      const body = {
        model: names.chat, messages, max_tokens: 32,
        ...(suite === 'on-your-data' ? { data_sources: config.dataSources } : {}),
      };
      const result = legacy ? await client.getChatCompletions(names.chat, messages, old) : await client.chat.completions.create(body, request);
      assert.ok(result.choices?.[0]?.message?.content?.trim(), 'Expected chat text');
      if (suite === 'on-your-data') {
        const context = result.choices[0].message.context;
        assert.ok(Array.isArray(context?.citations) && context.citations.length, 'Expected grounding citations');
      }
      if (suite === 'azure-filters') {
        const filters = legacy ? result.choices[0].contentFilterResults : result.choices[0].content_filter_results;
        assert.ok(filters && typeof filters === 'object', 'Expected Azure choice filter metadata');
        const prompts = legacy ? result.promptFilterResults : result.prompt_filter_results;
        assert.ok(Array.isArray(prompts) && prompts.length, 'Expected Azure prompt filter metadata');
      }
      return { kind: 'text', nonempty: true };
    }
    if (['chat-stream', 'completions-stream'].includes(suite)) {
      const chat = suite === 'chat-stream';
      const model = chat ? names.chat : names.completions;
      const stream = legacy
        ? await client[chat ? 'streamChatCompletions' : 'streamCompletions'](model, chat ? messages : ['Say compatibility.'], { ...oldOptions, maxTokens: 32 })
        : await (chat ? client.chat.completions : client.completions).create({
          model, ...(chat ? { messages } : { prompt: ['Say compatibility.'] }), max_tokens: 32, stream: true,
        }, request);
      let text = '';
      let finished = false;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        for (const choice of chunk.choices ?? []) {
          text += (chat ? choice.delta?.content : choice.text) ?? '';
          if (legacy ? choice.finishReason : choice.finish_reason) finished = true;
        }
      }
      assert.ok(text.trim(), 'Expected streamed text');
      assert.ok(finished, 'Stream ended without a finish reason');
      return { kind: 'stream', nonempty: true, finished };
    }
    if (suite === 'embeddings') {
      const result = legacy ? await client.getEmbeddings(names.embeddings, ['compatibility'], oldOptions)
        : await client.embeddings.create({ model: names.embeddings, input: ['compatibility'], encoding_format: 'float' }, request);
      const embedding = result.data?.[0]?.embedding;
      assert.ok(Array.isArray(embedding) && embedding.length && embedding.every(Number.isFinite), 'Expected finite numeric embedding');
      assert.ok((legacy ? result.usage?.totalTokens : result.usage?.total_tokens) > 0, 'Expected token usage');
      return { kind: 'embedding', dimensions: embedding.length };
    }
    if (suite === 'completions') {
      const result = legacy ? await client.getCompletions(names.completions, ['Say compatibility.'], { ...oldOptions, maxTokens: 32 })
        : await client.completions.create({ model: names.completions, prompt: ['Say compatibility.'], max_tokens: 32 }, request);
      assert.ok(result.choices?.[0]?.text?.trim(), 'Expected completion text');
      return { kind: 'text', nonempty: true };
    }
    if (suite === 'images') {
      const body = { prompt: 'A plain blue square on white.', n: 1, size: '1024x1024' };
      const result = legacy ? await client.getImages(names.images, body.prompt, { ...oldOptions, n: 1, size: body.size })
        : await client.images.generate({ model: names.images, ...body }, request);
      assert.ok(result.data?.[0]?.url || result.data?.[0]?.b64_json || result.data?.[0]?.base64Data, 'Expected image output');
      return { kind: 'image', nonempty: true };
    }
    const bytes = await readAudioFixture(config);
    const transcription = suite === 'transcription';
    const result = legacy
      ? await client[transcription ? 'getAudioTranscription' : 'getAudioTranslation'](names[suite], bytes, oldOptions)
      : await client.audio[transcription ? 'transcriptions' : 'translations'].create({
        model: names[suite], file: await SDK.toFile(bytes, 'fixture.wav'),
      }, request);
    assert.ok(result.text?.trim(), 'Expected audio result text');
    return { kind: 'text', nonempty: true };
  } finally {
    clearTimeout(timer);
  }
}

export function toLegacyDataSource(source) {
  if (source.type !== 'azure_search') throw new Error('Legacy live grounding currently supports azure_search only.');
  function camel(value) {
    if (Array.isArray(value)) return value.map(camel);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), camel(item)]));
  }
  return { type: source.type, ...camel(source.parameters) };
}

export async function runLiveMatrix(config, clients, run = runLiveCase) {
  const results = [];
  for (const suite of config.suites.filter((suite) => !['responses', 'azure-companion'].includes(suite))) {
    for (const target of clients) {
      if (['on-your-data', 'azure-filters'].includes(suite) && target.provider !== 'azure') continue;
      try {
        results.push({ suite, client: target.id, provider: target.provider, status: 'passed', result: await run(target, suite, config) });
      } catch (error) {
        // Never persist service error messages, prompts, URLs, credentials, or raw responses.
        results.push({ suite, client: target.id, provider: target.provider, status: 'failed',
          error: {
            name: ['AssertionError', 'Error', 'APIError', 'NotFoundError', 'AuthenticationError', 'PermissionDeniedError', 'RateLimitError', 'BadRequestError'].includes(error?.name) ? error.name : 'ServiceError',
            status: Number.isInteger(error?.status ?? error?.statusCode) ? error.status ?? error.statusCode : null,
          } });
      }
    }
    if (suite === 'embeddings') {
      for (const provider of ['azure', 'openai']) {
        const group = results.filter((entry) => entry.suite === suite && entry.provider === provider && entry.status === 'passed');
        if (new Set(group.map((entry) => entry.result.dimensions)).size > 1) {
          results.push({ suite, client: `${provider}-dimension-parity`, provider, status: 'failed', error: { name: 'EmbeddingDimensionMismatch', status: null } });
        }
      }
    }
  }
  return results;
}
