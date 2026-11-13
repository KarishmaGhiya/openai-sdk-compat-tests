import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as Baseline from 'openai';
import * as Current from 'openai-current';
import { AzureCliCredential, getBearerTokenProvider } from '@azure/identity';
import { azureExtensionFields, compileAzureProbe, probeAzureTypes } from './azure-types.mjs';
import { readJSON, root } from './io.mjs';

const field = (id, path, location = 'response') => ({ id, path: path.split('.'), location });
export const companionCases = {
  chat: { deployment: 'chat', fields: [
    field('ChatCompletion.prompt_filter_results', 'prompt_filter_results'),
    field('ChatCompletion.Choice.content_filter_results', 'choices.*.content_filter_results'),
  ] },
  'chat-stream': { deployment: 'chat', fields: [
    field('ChatCompletionChunk.prompt_filter_results', 'prompt_filter_results'),
    field('ChatCompletionChunk.Choice.content_filter_results', 'choices.*.content_filter_results'),
  ] },
  grounding: { deployment: 'chat', fields: [
    field('ChatCompletionCreateParamsNonStreaming.data_sources', 'data_sources', 'request'),
    field('ChatCompletionMessage.context', 'choices.*.message.context'),
  ] },
  'grounding-stream': { deployment: 'chat', fields: [
    field('ChatCompletionCreateParamsStreaming.data_sources', 'data_sources', 'request'),
    field('ChatCompletionChunk.Choice.Delta.context', 'choices.*.delta.context'),
  ] },
  completions: { deployment: 'completions', fields: [
    field('Completion.prompt_filter_results', 'prompt_filter_results'),
    field('CompletionChoice.content_filter_results', 'choices.*.content_filter_results'),
  ] },
  images: { deployment: 'images', fields: [
    field('ImagesResponse.prompt_filter_results', 'prompt_filter_results'),
    field('ImagesResponse.content_filter_results', 'content_filter_results'),
  ] },
  'upload-parts': { fields: [field('UploadPart.azure_block_id', 'azure_block_id')] },
};

export function validateCompanionConfig(config) {
  const options = config.azureCompanion;
  if (!options || !Array.isArray(options.features) || !options.features.length ||
    new Set(options.features).size !== options.features.length ||
    options.features.some((feature) => !Object.hasOwn(companionCases, feature))) throw new Error('Choose distinct known Azure companion features.');
  if (options.tokenParameter !== undefined && !['max_tokens', 'max_completion_tokens'].includes(options.tokenParameter)) {
    throw new Error('Unsupported Azure companion token parameter.');
  }
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 4096)) {
    throw new Error('Azure companion maxTokens must be between 1 and 4096.');
  }
  for (const feature of options.features) {
    const deployment = companionCases[feature].deployment;
    if (deployment && (typeof config.azureDeployments?.[deployment] !== 'string' || !config.azureDeployments[deployment].trim())) {
      throw new Error(`Missing Azure companion deployment: ${deployment}.`);
    }
  }
  if (options.features.some((feature) => feature.startsWith('grounding')) &&
    (!Array.isArray(config.dataSources) || !config.dataSources.length ||
      config.dataSources.some((source) => source?.type !== 'azure_search' ||
        !source.parameters?.endpoint || !source.parameters?.index_name) ||
      typeof options.groundingPrompt !== 'string' || !options.groundingPrompt.trim())) {
    throw new Error('Azure companion grounding requires an Azure Search endpoint, index, and groundingPrompt.');
  }
}

let preparation;
export async function prepareCompanionLive(config) {
  validateCompanionConfig(config);
  preparation ??= (async () => {
    const source = await readFile(join(root, 'compat', 'azure-companion-scenarios.mts'), 'utf8');
    const text = source.replace('import "@azure/openai/types";', '');
    const mapped = new Set(Object.values(companionCases).flatMap((entry) => entry.fields.map(({ id }) => id)));
    const fields = await azureExtensionFields();
    if (fields.some((entry) => !mapped.has(`${entry.type}.${entry.field}`))) throw new Error('New Azure companion fields require live scenario review.');
    const packages = [];
    for (const name of ['openai', 'openai-current']) {
      if (compileAzureProbe(name, text, true).length) throw new Error('Azure companion live scenarios do not type-check.');
      packages.push({
        package: name, version: (await readJSON(join('node_modules', name, 'package.json'))).version,
        fields: await probeAzureTypes(name),
      });
    }
    const directory = join(root, '.cache');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'azure-companion-scenarios.mjs');
    await writeFile(file, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    }).outputText);
    return { execute: (await import(pathToFileURL(file).href)).execute, packages,
      companionVersion: (await readJSON('node_modules/@azure/openai/package.json')).version };
  })();
  return preparation;
}

function valuesAt(value, [head, ...tail]) {
  if (head === undefined) return value === undefined || value === null ? [] : [value];
  if (head === '*') return Array.isArray(value) ? value.flatMap((item) => valuesAt(item, tail)) : [];
  return valuesAt(value?.[head], tail);
}

async function readStreamEvidence(response, collect) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator;
      while ((separator = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && separator[0] === '\r' && separator.index === buffer.length - 1) break;
        const line = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (!line) {
          const payload = data.join('\n');
          data = [];
          if (payload.trim() === '[DONE]') return;
          if (payload) collect(JSON.parse(payload));
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) return;
    }
  } finally {
    // The SDK owns the other tee branch; awaiting cancellation can deadlock it.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function companionEvidence(feature) {
  const specification = companionCases[feature];
  const wire = new Map(specification.fields.map(({ id }) => [id, []]));
  const sdk = new Map(specification.fields.map(({ id }) => [id, []]));
  let unreadable = false;
  const pending = [];
  const collect = (location, value) => {
    for (const entry of specification.fields.filter((entry) => entry.location === location)) {
      wire.get(entry.id).push(...valuesAt(value, entry.path));
    }
  };
  return {
    observe(id, value) {
      if (value !== undefined && value !== null && sdk.has(id)) sdk.get(id).push(value);
    },
    fetch(send = globalThis.fetch) {
      return async (url, init) => {
        if (specification.fields.some((entry) => entry.location === 'request')) {
          try { collect('request', JSON.parse(init.body)); } catch { unreadable = true; }
        }
        const response = await send(url, init);
        if (response.ok) {
          const copy = response.clone();
          pending.push((async () => {
            try {
              if (copy.headers.get('content-type')?.includes('text/event-stream')) {
                await readStreamEvidence(copy, (value) => collect('response', value));
              } else collect('response', await copy.json());
            } catch { unreadable = true; }
          })());
        }
        return response;
      };
    },
    async finish(types, completed = true) {
      await Promise.all(pending);
      return specification.fields.map(({ id }) => {
        const entry = types.find((entry) => `${entry.type}.${entry.field}` === id);
        const raw = wire.get(id);
        const decoded = sdk.get(id);
        return {
          id, nativeTyped: entry?.callSite?.native === true, withAzureTypes: entry?.callSite?.withAzureTypes === true,
          declaredWithAzureTypes: entry?.withAzureTypes === true,
          wireObservations: raw.length, sdkObservations: decoded.length,
          status: !completed ? 'not-evaluated-scenario-failed' : unreadable ? 'wire-evidence-unavailable'
            : raw.length === 0 && decoded.length === 0 ? 'not-observed-on-wire'
            : isDeepStrictEqual(raw, decoded) ? 'preserved' : 'runtime-mismatch',
        };
      });
    },
  };
}

export async function runCompanionLiveMatrix(config, { credential, fetch = globalThis.fetch } = {}) {
  const prepared = await prepareCompanionLive(config);
  const results = [];
  const tokenProvider = config.azureAuth === 'entra'
    ? getBearerTokenProvider(credential ?? new AzureCliCredential(), 'https://cognitiveservices.azure.com/.default') : undefined;
  for (const [index, SDK] of [Baseline, Current].entries()) {
    const entry = prepared.packages[index];
    for (const feature of config.azureCompanion.features) {
      const evidence = companionEvidence(feature);
      const client = new SDK.AzureOpenAI({
        endpoint: config.endpoint, apiVersion: config.apiVersion,
        ...(tokenProvider ? { apiKey: null, azureADTokenProvider: tokenProvider } : { apiKey: config.azureApiKey }),
        maxRetries: 0, timeout: 120_000, logLevel: 'off', fetch: evidence.fetch(fetch),
      });
      const row = { suite: 'azure-companion', feature, provider: 'azure',
        client: `${index === 0 ? 'baseline' : 'current'}-azure-companion`, version: entry.version };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Azure companion deadline exceeded')), 120_000);
      let error;
      try {
        await prepared.execute(client, feature, {
          model: config.azureDeployments?.[companionCases[feature].deployment] ?? '',
          tokenParameter: config.azureCompanion.tokenParameter ?? 'max_completion_tokens',
          maxTokens: config.azureCompanion.maxTokens ?? 128, dataSources: config.dataSources,
          groundingPrompt: config.azureCompanion.groundingPrompt,
        }, { signal: controller.signal, timeout: 120_000, maxRetries: 0 }, evidence.observe);
      } catch (failure) {
        const status = failure?.status;
        const assertion = failure?.compatibilityAssertion;
        error = { name: 'CompanionScenarioError', status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          ...(['chat-output', 'grounding-citations', 'completed-stream', 'completion-output', 'image-output', 'upload-id', 'upload-part-id', 'upload-cleanup']
            .includes(assertion) ? { assertion } : {}) };
      } finally {
        clearTimeout(timer);
      }
      const fields = await evidence.finish(entry.fields, !error);
      results.push({
        ...row, fields,
        status: error || fields.some((entry) => ['runtime-mismatch', 'wire-evidence-unavailable'].includes(entry.status)) ? 'failed'
          : fields.some((entry) => entry.status === 'not-observed-on-wire') ? 'not-observed' : 'passed',
        ...(error ? { error } : {}),
      });
    }
  }
  const exercised = new Set(results.flatMap((row) => row.fields.map(({ id }) => id)));
  const inventoried = prepared.packages[0].fields.map((entry) => `${entry.type}.${entry.field}`);
  const verified = inventoried.filter((id) => {
    const observations = results.flatMap((row) => row.fields.filter((field) => field.id === id)
      .map((field) => row.status === 'passed' && field.status === 'preserved'));
    return observations.length === prepared.packages.length && observations.every(Boolean);
  });
  return {
    companionVersion: prepared.companionVersion,
    comparison: 'Native OpenAI typings versus stable @azure/openai augmentation; executed augmented TypeScript scenarios on AzureOpenAI and compared live wire fields with SDK-exposed values.',
    independentRuntime: false,
    packages: prepared.packages,
    fieldCoverage: { inventoried: inventoried.length, selected: exercised.size, verifiedOnBothSDKs: verified.length,
      complete: verified.length === inventoried.length },
    unselectedFields: inventoried.filter((id) => !exercised.has(id)),
    results,
  };
}
