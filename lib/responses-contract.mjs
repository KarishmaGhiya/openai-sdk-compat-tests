import assert from 'node:assert/strict';

export const responsesTargets = ['openai', 'azure-versioned', 'azure-v1'];
export const responsesModel = 'compat-responses-deployment';
export const responsesEndpoint = 'https://compat.openai.azure.com';
export const responsesApiVersion = '2025-04-01-preview';
export const responsesKey = 'offline-responses-key';

export function responseFixture(overrides = {}) {
  return {
    id: 'resp_compat', object: 'response', created_at: 1_700_000_000, model: responsesModel,
    status: 'completed', error: null, incomplete_details: null, instructions: null,
    output: [{
      type: 'message', id: 'msg_compat', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'compatibility', annotations: [], logprobs: [] }],
    }],
    metadata: {}, parallel_tool_calls: false, tool_choice: 'auto', tools: [],
    temperature: 1, top_p: 1,
    usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    ...overrides,
  };
}

export function responseEvents(response = responseFixture()) {
  const message = response.output[0];
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: message.content[0].text, logprobs: [] },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: message.id, text: message.content[0].text, logprobs: [] },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

export function makeResponsesClient(SDK, {
  target, apiKey = responsesKey, endpoint = responsesEndpoint, apiVersion = responsesApiVersion,
  tokenProvider, fetch = globalThis.fetch,
}) {
  const options = { timeout: 120_000, maxRetries: 0, logLevel: 'off', fetch };
  if (target === 'azure-versioned') return new SDK.AzureOpenAI({
    ...options, endpoint, apiVersion,
    ...(tokenProvider ? { apiKey: null, azureADTokenProvider: tokenProvider } : { apiKey }),
  });
  if (!['openai', 'azure-v1'].includes(target)) throw new Error('Unknown Responses target.');
  return new SDK.default({
    ...options,
    baseURL: target === 'azure-v1' ? `${endpoint.replace(/\/$/, '')}/openai/v1` : 'https://api.openai.com/v1',
    apiKey: tokenProvider ? 'in-memory-entra-token-provider' : apiKey,
    ...(tokenProvider ? { fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${await tokenProvider()}`);
      return fetch(url, { ...init, headers });
    } } : {}),
  });
}

export function responsesTransport(SDK, target, respond = () => ({ body: responseFixture() }), options = {}) {
  const requests = [];
  const client = makeResponsesClient(SDK, {
    target, ...options,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const text = await request.text();
      const captured = {
        url: new URL(request.url), method: request.method,
        headers: Object.fromEntries(request.headers), body: text ? JSON.parse(text) : null,
      };
      requests.push(captured);
      const reply = await respond(captured, requests.length);
      const headers = { 'content-type': reply.events ? 'text/event-stream' : 'application/json', 'x-request-id': 'req_compat' };
      const body = reply.events
        ? reply.events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
        : reply.status === 204 ? null : JSON.stringify(reply.body);
      return new Response(body, { status: reply.status ?? 200, headers });
    },
  });
  return { client, requests };
}

export async function responsesStreamErrorDelivery(SDK, target) {
  const event = { type: 'error', sequence_number: 0, code: 'offline_error', message: 'offline error', param: null };
  const { client } = responsesTransport(SDK, target, () => ({ events: [event] }));
  try {
    const received = [];
    for await (const item of await client.responses.create({ model: responsesModel, input: 'test', stream: true })) received.push(item);
    assert.deepEqual(received, [event]);
    return 'event';
  } catch (error) {
    if (!(error instanceof SDK.APIError)) throw error;
    return 'exception';
  }
}

export async function responsesStreamStructuredParsing(SDK, target = 'openai') {
  const response = responseFixture();
  response.output[0].content[0].text = '{"ok":true}';
  const { client } = responsesTransport(SDK, target, () => ({ events: responseEvents(response) }));
  const result = await client.responses.stream({
    model: responsesModel, input: 'test',
    text: { format: { type: 'json_schema', name: 'test', strict: true, schema: {
      type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
    } } },
  }).finalResponse();
  if (result.output_parsed === null) return 'not-parsed';
  assert.deepEqual(result.output_parsed, { ok: true });
  return 'json-parsed';
}

function assertRouting(request, target, suffix, method) {
  const prefix = target === 'openai' ? '/v1' : target === 'azure-v1' ? '/openai/v1' : '/openai';
  assert.equal(request.url.hostname, target === 'openai' ? 'api.openai.com' : 'compat.openai.azure.com');
  assert.equal(request.url.pathname, `${prefix}${suffix}`);
  assert.equal(request.url.searchParams.get('api-version'), target === 'azure-versioned' ? responsesApiVersion : null);
  assert.equal(request.method, method);
  assert.equal(request.headers[target === 'azure-versioned' ? 'api-key' : 'authorization'],
    target === 'azure-versioned' ? responsesKey : `Bearer ${responsesKey}`);
}

const baseRequest = () => ({ model: responsesModel, input: 'Say compatibility.' });
const compactReply = () => ({ id: 'resp_compact', object: 'response.compaction', created_at: 1_700_000_000, output: [], usage: responseFixture().usage });
const listReply = () => ({
  object: 'list', data: [{ id: 'msg_input', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compatibility' }] }],
  has_more: false, first_id: 'msg_input', last_id: 'msg_input',
});

export async function executeResponsesContract(SDK, target, fixture) {
  if (fixture.ready !== true) throw new Error(`Unreviewed Responses contract: ${fixture.id}`);
  let reply = { body: responseFixture() };
  const transport = responsesTransport(SDK, target, () => reply);
  const { client, requests } = transport;
  const body = baseRequest();
  const value = structuredClone(fixture.value);
  let suffix = '/responses';
  let method = 'POST';
  let result;
  switch (fixture.kind) {
    case 'create': body[fixture.field] = value; break;
    case 'control': Object.assign(body, value); break;
    case 'tool': body.tools = [value]; break;
    case 'input': body.input = [value]; break;
    case 'content': body.input = [{ role: 'user', content: [value] }]; break;
    case 'format': body.text = { format: value }; break;
    case 'include': body.include = [value]; break;
    case 'tool-choice': body.tool_choice = value; break;
    case 'response': reply.body[fixture.field] = value; break;
    case 'output': reply.body.output = [value]; break;
    case 'output-content': reply.body.output[0].content = [value]; break;
    case 'status': reply.body.status = value; break;
    case 'event': {
      body.stream = true;
      reply = { events: [value] };
      const consume = async () => {
        const events = [];
        for await (const event of await client.responses.create(body)) events.push(event);
        return events;
      };
      if (value.type === 'error' && fixture.errorDelivery === 'exception') {
        await assert.rejects(consume(), (error) => {
          assert.ok(error instanceof SDK.APIError);
          assert.deepEqual(error.error, value);
          return true;
        });
      }
      else assert.deepEqual(await consume(), [value]);
      break;
    }
    case 'retrieve': {
      suffix = '/responses/resp_compat';
      method = 'GET';
      result = await client.responses.retrieve('resp_compat', { [fixture.field]: value });
      for (const item of Array.isArray(value) ? value : [value]) {
        assert.ok([...requests[0].url.searchParams].some(([key, actual]) =>
          key.replace(/\[\]$/, '') === fixture.field && actual === String(item)));
      }
      break;
    }
    case 'compact':
      suffix = '/responses/compact';
      reply.body = compactReply();
      result = await client.responses.compact({ ...body, [fixture.field]: value });
      assert.equal(result.object, 'response.compaction');
      break;
    case 'input-tokens':
      suffix = '/responses/input_tokens';
      reply.body = { object: 'response.input_tokens', input_tokens: 7 };
      result = await client.responses.inputTokens.count({ ...body, [fixture.field]: value });
      assert.equal(result.input_tokens, 7);
      break;
    case 'input-items':
      suffix = '/responses/resp_compat/input_items';
      method = 'GET';
      reply.body = listReply();
      result = await client.responses.inputItems.list('resp_compat', { [fixture.field]: value });
      assert.deepEqual(result.data, reply.body.data);
      for (const item of Array.isArray(value) ? value : [value]) {
        assert.ok([...requests[0].url.searchParams].some(([key, actual]) =>
          key.replace(/\[\]$/, '') === fixture.field && actual === String(item)));
      }
      break;
    case 'method': {
      switch (fixture.method) {
        case 'create': result = await client.responses.create(body); break;
        case 'retrieve':
          suffix += '/resp_compat'; method = 'GET';
          result = await client.responses.retrieve('resp_compat'); break;
        case 'delete':
          suffix += '/resp_compat'; method = 'DELETE'; reply = { status: 204 };
          result = await client.responses.delete('resp_compat'); assert.equal(result, null); break;
        case 'cancel':
          suffix += '/resp_compat/cancel'; reply.body.status = 'cancelled';
          result = await client.responses.cancel('resp_compat'); assert.equal(result.status, 'cancelled'); break;
        case 'compact':
          suffix += '/compact'; reply.body = compactReply();
          result = await client.responses.compact(body); assert.equal(result.object, 'response.compaction'); break;
        case 'inputItems.list':
          suffix += '/resp_compat/input_items'; method = 'GET'; reply.body = listReply();
          result = await client.responses.inputItems.list('resp_compat'); assert.deepEqual(result.data, reply.body.data); break;
        case 'inputTokens.count':
          suffix += '/input_tokens'; reply.body = { object: 'response.input_tokens', input_tokens: 7 };
          result = await client.responses.inputTokens.count(body); assert.equal(result.input_tokens, 7); break;
        case 'parse': {
          reply.body.output[0].content[0].text = '{"ok":true}';
          result = await client.responses.parse({
            ...body, text: { format: { type: 'json_schema', name: 'compat', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
          });
          assert.deepEqual(result.output_parsed, { ok: true });
          break;
        }
        case 'stream': {
          reply = { events: responseEvents() };
          const stream = client.responses.stream(body);
          let text = '';
          stream.on('response.output_text.delta', (event) => { text += event.delta; });
          result = await stream.finalResponse();
          assert.equal(text, 'compatibility');
          assert.equal(result.output_text, 'compatibility');
          break;
        }
        default: throw new Error(`Missing Responses method adapter: ${fixture.method}`);
      }
      break;
    }
    default: throw new Error(`Missing Responses contract adapter: ${fixture.kind}`);
  }
  if (!['event', 'retrieve', 'compact', 'input-tokens', 'input-items', 'method'].includes(fixture.kind)) {
    result = await client.responses.create(body);
    if (fixture.kind === 'response') {
      assert.deepEqual(result[fixture.field], value);
    } else if (fixture.kind === 'output') assert.deepEqual(result.output, [value]);
    else if (fixture.kind === 'output-content') assert.deepEqual(result.output[0].content, [value]);
    else if (fixture.kind === 'status') assert.equal(result.status, value);
    else assert.deepEqual(requests[0].body, body);
  }
  assert.equal(requests.length, 1, 'A contract must not silently retry or make unrelated requests.');
  assertRouting(requests[0], target, suffix, method);
  return { id: fixture.id, target, status: 'passed' };
}
