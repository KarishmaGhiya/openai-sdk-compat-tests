import { appendFile } from 'node:fs/promises';
import { compileAzureProbe, probeAzureTypes } from '../lib/azure-types.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';

const versions = {};
for (const name of ['openai', 'openai-current', '@azure/openai', 'azure-openai-legacy']) {
  versions[name] = (await readJSON(`node_modules/${name}/package.json`)).version;
}
const packages = [];
for (const name of ['openai', 'openai-current']) {
  const fields = await probeAzureTypes(name);
  const enhancementsProbe = `type Field = import("openai/resources/index").ChatCompletionCreateParamsNonStreaming["enhancements"];`;
  const enhancements = {
    native: compileAzureProbe(name, enhancementsProbe).length === 0,
    withAzureTypes: compileAzureProbe(name, enhancementsProbe, true).length === 0,
    runtimePassThrough: true,
    classification: 'legacy-request-type-gap',
    limitation: 'Transport accepts this field; current Azure service support is API-version/model-dependent and not established by this test.',
  };
  packages.push({ package: name, version: versions[name], fields, enhancements });
}
const report = {
  versions, packages,
  legacyMigrations: await readJSON('compat/azure-migrations.json'),
  scope: {
    offline: 'Eight legacy endpoint operations, Azure transport/auth and Azure extension type probes.',
    live: 'Separate opt-in suite; offline transport fixtures do not establish service support.',
    excluded: 'Not an exhaustive comparison of every Azure preview SDK, AssistantsClient, service API version, or model capability.',
  },
};
await writeJSON('reports/azure-compatibility.json', report);
const lines = [
  '## Azure/OpenAI SDK compatibility (offline)',
  '', '| OpenAI SDK | Azure extension fields | Native declarations | Patched declarations | Untyped actual call sites |',
  '|---|---:|---:|---:|---:|',
  ...packages.map((entry) => `| ${entry.version} | ${entry.fields.length} | ${entry.fields.filter((field) => field.native).length} | ${entry.fields.filter((field) => field.withAzureTypes).length} | ${entry.fields.filter((field) => !field.callSite.withAzureTypes).length} |`),
  '', 'The root UploadPart declaration is patched, but uploads.parts.create() still returns a type without azure_block_id in both pinned SDKs. This is a known typing gap, not proof of runtime data loss.',
  '', 'Legacy `enhancements` is not natively typed or added by the stable Azure companion; JSON transport pass-through is tested.',
  'Legacy camelCase methods/options/results require migration, not additional endpoints.',
  'Live service compatibility is not inferred from these offline results.',
];
const summary = `${lines.join('\n')}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
if (packages.some((entry) => entry.fields.some((field) => !field.withAzureTypes ||
  (!field.callSite.withAzureTypes && !field.callSite.reviewedGap)))) process.exitCode = 1;
