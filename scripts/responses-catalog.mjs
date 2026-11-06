import { responsesInventory, responsesPackages } from '../lib/responses-inventory.mjs';
import { responsesStreamErrorDelivery, responsesStreamStructuredParsing } from '../lib/responses-contract.mjs';
import { compareVersions, readJSON, writeJSON } from '../lib/io.mjs';

const accept = process.argv.includes('--accept-contracts');
let previous = { snapshots: [] };
try { previous = await readJSON('compat/responses-matrix.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const snapshots = new Map(previous.snapshots.map((snapshot) => [snapshot.version, snapshot]));
for (const name of responsesPackages) {
  const inventory = await responsesInventory(name);
  const SDK = await import(name);
  const errorDelivery = await responsesStreamErrorDelivery(SDK, 'openai');
  const old = snapshots.get(inventory.version);
  const rawJsonSchemaStreamParsing = await responsesStreamStructuredParsing(SDK);
  const previousBehavior = [...snapshots.values()].filter((snapshot) => compareVersions(snapshot.version, inventory.version) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version)).map((snapshot) => snapshot.behaviors?.rawJsonSchemaStreamParsing).filter(Boolean).at(-1);
  const isErrorEvent = (fixture) => fixture.kind === 'event' && fixture.value.type === 'error';
  snapshots.set(inventory.version, {
    version: inventory.version, schema: inventory.schema.map((entry) => ({
      ...entry, reviewed: accept || old?.schema.some((prior) => prior.name === entry.name && prior.hash === entry.hash && prior.reviewed !== false) || false,
    })),
    behaviors: { rawJsonSchemaStreamParsing: accept ? rawJsonSchemaStreamParsing : old?.behaviors?.rawJsonSchemaStreamParsing ?? previousBehavior },
    observedBehaviors: { rawJsonSchemaStreamParsing },
    fixtures: inventory.fixtures.map((fixture) => {
      const prior = old?.fixtures.find((entry) => entry.id === fixture.id);
      const unchanged = prior && prior.kind === fixture.kind && prior.type === fixture.type && prior.module === fixture.module;
      return {
        ...fixture, ...(unchanged && prior.ready ? { value: prior.value } : {}),
        ...(isErrorEvent(fixture) ? { errorDelivery: accept ? errorDelivery : prior?.errorDelivery ?? errorDelivery } : {}),
        ready: accept || (unchanged && prior.ready === true && (!isErrorEvent(fixture) || prior.errorDelivery === errorDelivery)) || false,
      };
    }),
    removedBaseline: ([...snapshots.values()][0] ?? inventory).fixtures.filter((entry) => !inventory.fixtures.some((fixture) => fixture.id === entry.id))
      .map((entry) => ({ id: entry.id, reviewed: accept || old?.removedBaseline?.some((prior) => prior.id === entry.id && prior.reviewed) || false })),
  });
}
await writeJSON('compat/responses-matrix.json', {
  schemaVersion: 1,
  scope: 'Typed SDK surface and transport fixtures, not a claim of service/model support or every parameter combination.',
  snapshots: [...snapshots.values()].sort((a, b) => compareVersions(a.version, b.version)),
});
const { responsesBuiltinIds, responsesFeatureIds } = await import('../lib/responses-live.mjs');
await writeJSON('compat/responses-live.template.json', Object.fromEntries(
  responsesFeatureIds.filter((id) => !responsesBuiltinIds.includes(id)).map((id) => [id, {
    azure: { ready: false, note: 'Supply a reviewed scenario with assertions and feature evidence, or an explicit unsupported declaration.' },
    openai: { ready: false, note: 'Supply a reviewed scenario with assertions and feature evidence, or an explicit unsupported declaration.' },
  }]),
));
console.log(`Generated Responses catalog. Contract review accepted: ${accept}. Live evidence is recorded separately.`);
