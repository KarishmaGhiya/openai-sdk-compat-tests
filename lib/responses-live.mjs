import assert from 'node:assert/strict';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { AzureCliCredential, getBearerTokenProvider } from '@azure/identity';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateCase } from './coverage.mjs';
import { executeScenario, assertResult } from './scenario.mjs';
import { compareVersions, readJSON, root } from './io.mjs';
import { makeResponsesClient } from './responses-contract.mjs';

const catalog = await readJSON('compat/responses-matrix.json');
const allFeatures = new Map(catalog.snapshots.flatMap((snapshot) => snapshot.fixtures).map((fixture) => [fixture.id, fixture]));
export const responsesFeatureIds = [...allFeatures.keys()].sort();
export const responsesBuiltinIds = [
  'method:create', 'method:retrieve', 'method:delete', 'method:inputItems.list',
  'method:inputTokens.count', 'method:compact', 'method:parse', 'method:stream', 'method:cancel',
  'tool:function', 'create:previous_response_id', 'format:text', 'format:json_object', 'format:json_schema',
];

export function planResponsesLive(config) {
  const options = config.responses;
  if (!options || !['full', 'selected'].includes(options.mode)) throw new Error('Choose an explicit Responses mode: full or selected.');
  if (!['v1', 'versioned', 'both'].includes(options.azureApiMode)) throw new Error('Choose an explicit Responses Azure API mode.');
  if (options.mode === 'full' && options.features !== undefined) throw new Error('A full Responses run cannot select a subset.');
  const features = options.mode === 'full' ? responsesFeatureIds : options.features;
  if (!Array.isArray(features) || !features.length || new Set(features).size !== features.length ||
    features.some((id) => !allFeatures.has(id))) throw new Error('Select distinct known Responses feature IDs.');
  const cases = { ...options.fileCases, ...options.cases };
  if (Object.keys(cases).some((id) => !allFeatures.has(id))) throw new Error('Unknown Responses fixture ID.');
  const entries = [];
  for (const id of features) {
    for (const provider of ['azure', 'openai']) {
      const definition = cases[id]?.[provider] ?? (responsesBuiltinIds.includes(id) ? { ready: true, builtin: true } : undefined);
      let status = 'ready';
      if (definition?.unsupported) {
        if (typeof definition.reason !== 'string' || !definition.reason.trim() ||
          !['service-limitation', 'model-limitation', 'api-version-limitation'].includes(definition.classification)) {
          throw new Error('Unsupported Responses features need an explicit reason and service/model/API classification.');
        }
        status = 'declared-unsupported';
      } else if (definition?.ready !== true) status = 'missing-fixture';
      else if (definition.builtin && !responsesBuiltinIds.includes(id)) status = 'invalid-fixture';
      else if (!definition.builtin) {
        const scenario = { ...definition.scenario, id, ready: true, covers: [id] };
        if (validateCase(scenario, {}).length) status = 'invalid-fixture';
        if (scenario.steps?.some((step) => step.method === 'responses.stream')) status = 'invalid-fixture';
        if (scenario.steps?.some((step) => ['responses.create', 'responses.parse'].includes(step.method) &&
          step.args?.[0]?.store !== false && !scenario.cleanup?.some((cleanup) => cleanup.method === 'responses.delete'))) status = 'invalid-fixture';
        for (const step of [...(scenario.steps ?? []), ...(scenario.cleanup ?? [])]) {
          for (const rule of step.assertions ?? []) {
            if (rule.op === 'matches') {
              try { new RegExp(rule.value); } catch { status = 'invalid-fixture'; }
            }
          }
        }
        const values = { ...options.values, RESPONSES_MODEL: provider === 'azure' ? config.azureDeployments?.responses : config.openaiModels?.responses };
        function validateVariables(value) {
          if (!value || typeof value !== 'object') return;
          if ('$env' in value && !values[value.$env]) status = 'invalid-fixture';
          Object.values(value).forEach(validateVariables);
        }
        validateVariables(scenario);
        const evidence = scenario.steps?.filter((step) => scenario.evidence?.[id]?.includes(step.id)) ?? [];
        if (!evidence.some((step) => step.method.startsWith('responses.'))) status = 'invalid-fixture';
        const feature = allFeatures.get(id);
        if (definition.expectedError && (feature.kind !== 'event' || feature.value.type !== 'error' ||
          typeof definition.expectedError.code !== 'string' || !definition.expectedError.code ||
          !evidence.some((step) => step.method === 'responses.create' && step.args?.[0]?.stream === true))) status = 'invalid-fixture';
        if (['create', 'tool', 'content', 'input', 'format', 'include', 'tool-choice', 'control'].includes(feature.kind)) {
          const bodies = evidence.filter((step) => ['responses.create', 'responses.parse', 'responses.stream'].includes(step.method)).map((step) => step.args?.[0]);
          const exercised = bodies.some((body) => {
            if (!body) return false;
            if (feature.kind === 'create') return Object.hasOwn(body, feature.field);
            const matches = (item) => item.type === feature.value.type && (!feature.field || Object.hasOwn(item, feature.field));
            if (feature.kind === 'tool') return body.tools?.some(matches);
            if (feature.kind === 'input') return body.input?.some?.(matches);
            if (feature.kind === 'content') return body.input?.some?.((item) => item.content?.some?.(matches));
            if (feature.kind === 'format') return body.text?.format && matches(body.text.format);
            if (feature.kind === 'include') return body.include?.includes(feature.value);
            if (feature.kind === 'tool-choice') return typeof feature.value === 'string'
              ? body.tool_choice === feature.value : body.tool_choice?.type === feature.value.type;
            const [control, field] = id.slice('control:'.length).split(':')[0].split('.');
            const object = Array.isArray(body[control]) ? body[control][0] : body[control];
            const expected = Array.isArray(feature.value[control]) ? feature.value[control][0][field] : feature.value[control][field];
            return object && Object.hasOwn(object, field) &&
              (typeof expected !== 'string' || expected === 'compatibility' || object[field] === expected);
          });
          if (!exercised) status = 'invalid-fixture';
        }
        if (feature.kind === 'event' && !evidence.some((step) => step.capture === 'stream' &&
          step.assertions?.some((rule) => rule.path === 'types' && rule.op === 'includes' && rule.value === feature.value.type))) status = 'invalid-fixture';
        if (feature.kind === 'method' && !evidence.some((step) => step.method === `responses.${feature.method}`)) status = 'invalid-fixture';
        if (feature.kind === 'response' && !evidence.some((step) => step.assertions?.some((rule) =>
          rule.path.split('.').includes(feature.field)))) status = 'invalid-fixture';
        if (['output', 'output-content', 'status'].includes(feature.kind) && !evidence.some((step) => step.assertions?.some((rule) =>
          rule.op === 'equals' && rule.value === (feature.kind === 'status' ? feature.value : feature.value.type) &&
          rule.path.endsWith(feature.kind === 'status' ? 'status' : 'type')))) status = 'invalid-fixture';
        if (['output', 'output-content', 'event'].includes(feature.kind) && feature.field &&
          !definition.expectedError && !evidence.some((step) => step.assertions?.some((rule) =>
            rule.path.split('.').includes(feature.field)))) status = 'invalid-fixture';
      }
      entries.push({ id, provider, status, definition });
    }
  }
  return {
    mode: options.mode, features, entries,
    missing: entries.filter((entry) => ['missing-fixture', 'invalid-fixture'].includes(entry.status)).map(({ id, provider, status }) => ({ id, provider, status })),
  };
}

export async function prepareResponsesLive(config) {
  if (config.responses?.caseFile) {
    const fixtures = resolve(root, 'fixtures');
    const file = resolve(fixtures, config.responses.caseFile);
    const rel = relative(fixtures, file);
    if (isAbsolute(config.responses.caseFile) || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error('Responses caseFile must remain inside fixtures.');
    }
    config.responses.fileCases = await readJSON(file);
  }
  const plan = planResponsesLive(config);
  async function checkFiles(value) {
    if (!value || typeof value !== 'object') return;
    if ('$file' in value) {
      const fixtures = resolve(root, 'fixtures');
      const file = resolve(fixtures, value.$file);
      const rel = relative(fixtures, file);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Responses fixture file must remain inside fixtures.');
      await readFile(file);
    }
    for (const child of Object.values(value)) await checkFiles(child);
  }
  for (const entry of plan.entries.filter((entry) => entry.status === 'ready')) {
    try { await checkFiles(entry.definition.scenario); } catch {
      entry.status = 'missing-fixture';
      plan.missing.push({ id: entry.id, provider: entry.provider, status: entry.status });
    }
  }
  return plan;
}

export async function makeResponsesLiveClients(config, { credential } = {}) {
  const azureCredential = credential ?? new AzureCliCredential();
  const mode = config.responses.azureApiMode;
  const modes = mode === 'both' ? ['v1', 'versioned'] : [mode];
  const targets = [];
  for (const [name, SDK] of [['openai', Baseline], ['openai-current', Current]]) {
    const version = (await readJSON(join('node_modules', name, 'package.json'))).version;
    const snapshot = catalog.snapshots.filter((entry) => compareVersions(entry.version, version) <= 0).at(-1) ?? catalog.snapshots[0];
    const supported = new Set(snapshot.fixtures.map((entry) => entry.id));
    const label = name === 'openai' ? 'baseline' : 'current';
    for (const apiMode of modes) {
      const tokenProvider = config.azureAuth === 'entra' ? getBearerTokenProvider(azureCredential,
        apiMode === 'v1' ? 'https://ai.azure.com/.default' : 'https://cognitiveservices.azure.com/.default') : undefined;
      targets.push({
        id: `${label}-azure-${apiMode}`, provider: 'azure', SDK, version, supported,
        client: makeResponsesClient(SDK, {
          target: `azure-${apiMode}`, endpoint: config.endpoint, apiVersion: config.apiVersion,
          apiKey: config.azureApiKey, tokenProvider,
        }),
      });
    }
    targets.push({ id: `${label}-openai`, provider: 'openai', SDK, version, supported,
      client: makeResponsesClient(SDK, { target: 'openai', apiKey: config.openaiApiKey }) });
  }
  return targets;
}

const schema = { type: 'object', properties: { value: { type: 'integer', enum: [7] } }, required: ['value'], additionalProperties: false };
const functionTool = {
  type: 'function', name: 'compat_lookup', strict: true,
  parameters: { type: 'object', properties: { key: { type: 'string', enum: ['compat'] } }, required: ['key'], additionalProperties: false },
};

export async function runResponsesBuiltin(target, id, config, definition = {}) {
  const { client } = target;
  const model = definition.model ?? (target.provider === 'azure' ? config.azureDeployments.responses : config.openaiModels.responses);
  const body = { model, input: 'Reply with the single word compatibility.', max_output_tokens: 128, store: false, ...definition.body };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Responses live deadline exceeded')), 120_000);
  const options = { signal: controller.signal, timeout: 120_000, maxRetries: 0 };
  const stored = [];
  let failure;
  async function create(input, parse = false) {
    const response = await client.responses[parse ? 'parse' : 'create'](input, options);
    if (input.store !== false && response.id) stored.push(response.id);
    return response;
  }
  try {
    let response;
    if (id === 'method:stream') {
      const stream = client.responses.stream(body, options);
      let text = '';
      stream.on('response.created', (event) => {
        if (body.store !== false && event.response.id) stored.push(event.response.id);
      });
      stream.on('response.output_text.delta', (event) => { text += event.delta; });
      response = await stream.finalResponse();
      assert.equal(response.status, 'completed');
      assert.ok(text.trim() && response.output_text?.trim(), 'Expected completed streamed text');
    } else if (id === 'method:parse' || id.startsWith('format:')) {
      const format = id === 'format:text' ? { type: 'text' }
        : id === 'format:json_object' ? { type: 'json_object' }
          : { type: 'json_schema', name: 'compat', strict: true, schema };
      response = await create({ ...body, input: 'Return a JSON object with value equal to 7.', text: { format } }, id === 'method:parse');
      if (id === 'format:text') assert.ok(response.output_text?.trim());
      else assert.deepEqual(JSON.parse(response.output_text), { value: 7 });
      if (id === 'method:parse') assert.deepEqual(response.output_parsed, { value: 7 });
    } else if (id === 'tool:function') {
      const first = await create({ ...body, store: true, tools: [functionTool], tool_choice: { type: 'function', name: functionTool.name } });
      const call = first.output.find((item) => item.type === 'function_call');
      assert.ok(call?.call_id && call.name === functionTool.name, 'Expected requested function call');
      assert.deepEqual(JSON.parse(call.arguments), { key: 'compat' });
      response = await create({
        ...body, previous_response_id: first.id,
        input: [{ type: 'function_call_output', call_id: call.call_id, output: 'The result is compatibility.' }],
      });
      assert.ok(response.output_text?.trim(), 'Expected a response after function result submission');
    } else if (id === 'create:previous_response_id') {
      const first = await create({ ...body, store: true, input: 'Remember this marker: cerulean-bicycle-42. Acknowledge it.' });
      response = await create({ ...body, previous_response_id: first.id, input: 'What exact marker did I ask you to remember?' });
      assert.ok(response.output_text?.includes('cerulean-bicycle-42'), 'Expected previous-turn state');
    } else if (['method:retrieve', 'method:delete', 'method:inputItems.list', 'method:cancel'].includes(id)) {
      response = await create({
        ...body, store: true,
        ...(id === 'method:cancel' ? { background: true } : {}),
        ...(id === 'method:inputItems.list' ? { input: [
          { role: 'user', content: 'Remember the word compatibility.' },
          { role: 'user', content: 'Repeat that word.' },
        ] } : {}),
      });
      if (id === 'method:retrieve') {
        const retrieved = await client.responses.retrieve(response.id, {}, options);
        assert.equal(retrieved.id, response.id);
        assert.equal(retrieved.output_text, response.output_text);
      } else if (id === 'method:inputItems.list') {
        const items = await client.responses.inputItems.list(response.id, { limit: 1 }, options);
        assert.ok(items.data.length && items.data[0].type, 'Expected stored input items');
        assert.equal(items.hasNextPage(), true, 'Expected a second page of input items');
        const next = await items.getNextPage();
        assert.ok(next.data.length && next.data[0].id !== items.data[0].id, 'Expected distinct paginated input items');
      } else if (id === 'method:delete') {
        assert.equal(await client.responses.delete(response.id, options), null);
        stored.splice(stored.indexOf(response.id), 1);
        await assert.rejects(client.responses.retrieve(response.id, {}, options), (error) => error.status === 404);
      } else {
        assert.ok(['queued', 'in_progress'].includes(response.status), 'Response already finished; cancellation was not exercised');
        const cancelled = await client.responses.cancel(response.id, options);
        assert.equal(cancelled.id, response.id, 'Cancellation returned the wrong response');
        assert.equal(cancelled.status, 'cancelled');
      }
    } else if (id === 'method:compact') {
      response = await client.responses.compact({ model, input: body.input, ...definition.body }, options);
      assert.equal(response.object, 'response.compaction');
      assert.ok(Array.isArray(response.output) && response.output.length, 'Expected compacted state');
      assert.ok(response.output.some((item) => item.type === 'compaction' &&
        typeof item.encrypted_content === 'string' && item.encrypted_content.trim()), 'Expected an encrypted compaction item');
    } else if (id === 'method:inputTokens.count') {
      response = await client.responses.inputTokens.count({ model, input: body.input, ...definition.body }, options);
      assert.equal(response.object, 'response.input_tokens');
      assert.ok(Number.isInteger(response.input_tokens) && response.input_tokens > 0);
    } else if (id === 'method:create') {
      response = await create(body);
      assert.equal(response.status, 'completed');
      assert.ok(response.output_text?.trim(), 'Expected response text');
      assert.ok(response.usage?.total_tokens > 0, 'Expected token usage');
    } else throw new Error('Missing live Responses builtin adapter.');
    if (definition.assertions) assertResult(response, definition.assertions);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    for (const id of stored.reverse()) {
      try { await client.responses.delete(id, { timeout: 30_000, maxRetries: 0 }); } catch (error) { failure = new AggregateError([failure, error].filter(Boolean), 'Responses case or cleanup failed'); }
    }
  }
  if (failure) throw failure;
  return { status: 'passed' };
}

export async function runResponsesLiveMatrix(config, targets, runBuiltin = runResponsesBuiltin) {
  const plan = planResponsesLive(config);
  if (plan.missing.length) return {
    suite: 'responses', mode: plan.mode, complete: false,
    results: plan.entries.map(({ id, provider, status }) => ({
      feature: id, provider, status: status === 'ready' ? 'blocked-before-paid-calls' : status,
    })),
  };
  const results = [];
  for (const target of targets) {
    for (const entry of plan.entries.filter((item) => item.provider === target.provider)) {
      const row = { feature: entry.id, provider: target.provider, client: target.id, version: target.version };
      if (!target.supported.has(entry.id)) {
        results.push({ ...row, status: 'sdk-unavailable', classification: 'sdk-version-surface-gap' });
      } else if (entry.status === 'declared-unsupported') {
        results.push({ ...row, status: 'declared-unsupported', classification: entry.definition.classification, evidence: 'configuration-only-not-live-verified' });
      } else {
        try {
          if (entry.definition.builtin) await runBuiltin(target, entry.id, config, entry.definition);
          else {
            const model = entry.definition.model ?? (target.provider === 'azure' ? config.azureDeployments.responses : config.openaiModels.responses);
            await executeScenario(target.client, { ...entry.definition.scenario, id: entry.id }, {}, {
              env: { ...config.responses.values, RESPONSES_MODEL: model },
              fixtureDirectory: join(root, 'fixtures'), toFile: target.SDK.toFile,
            });
          }
          results.push({ ...row, status: 'passed' });
        } catch (error) {
          const original = error instanceof AggregateError ? error.errors[0] : error;
          if (entry.definition.expectedError && original instanceof target.SDK.APIError &&
            original.status === undefined && original.code === entry.definition.expectedError.code &&
            original.error?.type === 'error' && !original.cleanup &&
            (!(error instanceof AggregateError) || error.errors.length === 1)) {
            results.push({ ...row, status: 'passed', evidence: 'expected-stream-exception' });
            continue;
          }
          const status = original?.status ?? original?.statusCode;
          results.push({
            ...row, status: 'failed',
            error: {
              name: original?.name === 'AssertionError' ? 'AssertionError' : 'ResponsesError',
              status: Number.isInteger(status) ? status : null,
            },
            classification: Number.isInteger(status) ? 'service-rejection-investigate-api-model-config-before-sdk' : 'runtime-or-assertion-failure',
          });
        }
      }
    }
  }
  return { suite: 'responses', mode: plan.mode, complete: plan.mode === 'full' && results.length > 0 && results.every((row) => row.status === 'passed'), results };
}
