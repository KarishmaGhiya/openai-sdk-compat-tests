import { Readable } from 'node:stream';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import { OpenAIClient, AzureKeyCredential } from 'azure-openai-legacy';

export const azureEndpoint = 'https://compat.openai.azure.com';
export const apiVersion = '2024-10-21';
export const deployment = 'compat-deployment';
export const fakeKey = 'offline-azure-compat-key';
export const messages = [{ role: 'user', content: 'Say compatibility.' }];
export const chatResponse = {
  id: 'chatcmpl-compat', object: 'chat.completion', created: 1_700_000_000, model: deployment,
  prompt_filter_results: [{ prompt_index: 0, content_filter_results: { hate: { filtered: false, severity: 'safe' } } }],
  choices: [{
    index: 0, finish_reason: 'stop', logprobs: null,
    message: { role: 'assistant', content: 'compatibility', refusal: null, context: { citations: [{ content: 'source', title: 'fixture' }], intent: 'test' } },
    content_filter_results: { hate: { filtered: false, severity: 'safe' } },
  }],
  usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
};

export const contracts = {
  chat: {
    suffix: '/chat/completions',
    legacy: (client, options = {}) => client.getChatCompletions(deployment, messages, { maxTokens: 32, temperature: 0, ...options }),
    modern: (client, options = {}) => client.chat.completions.create({ model: deployment, messages, max_tokens: 32, temperature: 0, ...options }),
    response: chatResponse,
  },
  completions: {
    suffix: '/completions',
    legacy: (client) => client.getCompletions(deployment, ['Say compatibility.'], { maxTokens: 32 }),
    modern: (client) => client.completions.create({ model: deployment, prompt: ['Say compatibility.'], max_tokens: 32 }),
    response: { id: 'cmpl-compat', object: 'text_completion', created: 1_700_000_000, model: deployment, choices: [{ index: 0, text: 'compatibility', finish_reason: 'stop', logprobs: null }], usage: chatResponse.usage },
  },
  embeddings: {
    suffix: '/embeddings',
    legacy: (client) => client.getEmbeddings(deployment, ['compatibility']),
    modern: (client) => client.embeddings.create({ model: deployment, input: ['compatibility'], encoding_format: 'float' }),
    response: { object: 'list', model: deployment, data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1, total_tokens: 1 } },
  },
  images: {
    suffix: '/images/generations',
    legacy: (client) => client.getImages(deployment, 'A plain blue square.', { n: 1, size: '1024x1024' }),
    modern: (client) => client.images.generate({ model: deployment, prompt: 'A plain blue square.', n: 1, size: '1024x1024' }),
    response: { created: 1_700_000_000, data: [{ url: 'https://example.invalid/image.png', revised_prompt: 'A plain blue square.' }] },
  },
};

export function legacyTransport(response, { stream = false, credential, status = 200 } = {}) {
  const requests = [];
  const client = new OpenAIClient(azureEndpoint, credential ?? new AzureKeyCredential(fakeKey), {
    apiVersion, retryOptions: { maxRetries: 0 },
    httpClient: { async sendRequest(request) {
      requests.push({
        url: new URL(request.url), headers: request.headers.toJSON(),
        body: typeof request.body === 'string' ? JSON.parse(request.body) : request.body,
        multipartBody: request.multipartBody,
      });
      return {
        request, status,
        headers: createHttpHeaders({ 'content-type': stream ? 'text/event-stream' : 'application/json' }),
        ...(stream ? { readableStreamBody: Readable.from([Buffer.from(response)]) } : { bodyAsText: JSON.stringify(response) }),
      };
    } },
  });
  return { client, requests };
}

export function modernTransport(SDK, response, { stream = false, tokenProvider, status = 200 } = {}) {
  const requests = [];
  const client = new SDK.AzureOpenAI({
    endpoint: azureEndpoint, apiVersion,
    ...(tokenProvider ? { apiKey: null, azureADTokenProvider: tokenProvider } : { apiKey: fakeKey }),
    maxRetries: 0,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const multipart = request.headers.get('content-type')?.startsWith('multipart/form-data');
      requests.push({
        url: new URL(request.url), headers: Object.fromEntries(request.headers),
        body: multipart ? await request.formData() : await request.json(),
      });
      return new Response(stream ? response : JSON.stringify(response), {
        status, headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
      });
    },
  });
  return { client, requests };
}
