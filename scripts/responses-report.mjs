import { appendFile } from 'node:fs/promises';
import { azureExtensionFields, compileAzureProbe, probeAzureTypes } from '../lib/azure-types.mjs';
import { responsesCoverage, responsesInventory, responsesPackages } from '../lib/responses-inventory.mjs';
import { responsesStreamErrorDelivery, responsesStreamStructuredParsing } from '../lib/responses-contract.mjs';
import { responsesBuiltinIds, responsesFeatureIds } from '../lib/responses-live.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';
import { renderResponsesSummary } from '../lib/compat-summary.mjs';

const catalog = await readJSON('compat/responses-matrix.json');
const packages = [];
for (const name of responsesPackages) {
  const inventory = await responsesInventory(name);
  const coverage = responsesCoverage(inventory, catalog);
  const fields = await probeAzureTypes(name);
  packages.push({
    package: name, version: inventory.version,
    responses: {
      featureCount: inventory.fixtures.length,
      features: inventory.fixtures.map(({ id }) => id),
      missingContracts: coverage.missing, unreviewedSchemas: coverage.unreviewedSchemas,
      removedBaseline: coverage.removedBaseline,
      unreviewedRemovals: coverage.unreviewedRemovals,
      errorDelivery: await responsesStreamErrorDelivery(await import(name), 'openai'),
      rawJsonSchemaStreamParsing: await responsesStreamStructuredParsing(await import(name)),
    },
    azureNativeTypeGaps: fields.filter((field) => !field.native),
    legacyEnhancements: {
      nativeTyped: compileAzureProbe(name, 'type Field = import("openai/resources/index").ChatCompletionCreateParamsNonStreaming["enhancements"];').length === 0,
      companionTyped: compileAzureProbe(name, 'type Field = import("openai/resources/index").ChatCompletionCreateParamsNonStreaming["enhancements"];', true).length === 0,
      runtimePassThrough: true, serviceVerified: false, classification: 'legacy-request-type-gap',
    },
  });
}
const baseline = new Set(packages[0].responses.features);
const current = new Set(packages[1].responses.features);
const report = {
  scope: 'Pinned SDK declarations and actual injected transports; not live service acceptance or every parameter combination.',
  packages,
  references: {
    azureCompanionVersion: (await readJSON('node_modules/@azure/openai/package.json')).version,
    legacyAzureVersion: (await readJSON('node_modules/azure-openai-legacy/package.json')).version,
  },
  responsesAddedByAzureCompanion: (await azureExtensionFields()).filter((field) => /^(Responses?|InputItem|InputToken)/.test(field.type)),
  legacyAzureResponses: { available: false, classification: 'no-legacy-equivalent-not-a-native-openai-gap' },
  responsesVersionDifferences: {
    added: [...current].filter((id) => !baseline.has(id)),
    removed: [...baseline].filter((id) => !current.has(id)),
    streamingErrorDelivery: packages.map((entry) => ({ version: entry.version, delivery: entry.responses.errorDelivery })),
    rawJsonSchemaStreamParsing: packages.map((entry) => ({ version: entry.version, behavior: entry.responses.rawJsonSchemaStreamParsing })),
    classification: 'sdk-version-surface-and-behavior-drift',
  },
  live: {
    status: 'not-executed-by-offline-report',
    builtinFunctionalCases: responsesBuiltinIds,
    featuresRequiringReviewedProviderFixtures: responsesFeatureIds.filter((id) => !responsesBuiltinIds.includes(id)),
    note: 'Full mode blocks before paid calls on missing/invalid fixtures; configured unsupported capabilities are not passes. Live evidence is in azure-live.json.',
  },
};
await writeJSON('reports/responses-compatibility.json', report);
const summary = renderResponsesSummary(report);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
if (packages.some((entry) => entry.responses.missingContracts.length || entry.responses.unreviewedSchemas.length || entry.responses.unreviewedRemovals.length ||
  entry.azureNativeTypeGaps.some((field) => !field.withAzureTypes))) process.exitCode = 1;
