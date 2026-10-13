import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicableCases, coverageReport, livePlan, validateCase } from '../lib/coverage.mjs';
import { readJSON } from '../lib/io.mjs';

const endpoint = 'endpoint:models.list';
const case_ = () => ({
  id: 'models', since: '7.3.0', ready: true, covers: [endpoint],
  steps: [{ id: 'list', method: 'models.list', args: [], optionsIndex: 0, assertions: [{ path: 'data', op: 'type', value: 'array' }] }],
});
const releases = [
  { version: '7.3.0', methods: ['models.list'], requirements: [], baselineMissing: [] },
  { version: '7.4.0', methods: ['models.list', 'models.retrieve'], requirements: [{ id: 'new-model' }], baselineMissing: [] },
];

test('empty argument arrays are valid; drafts and incomplete fixtures never count as coverage', () => {
  assert.equal(coverageReport(releases, [case_()], {}, '7.3.0').complete, true);
  const draft = { ...case_(), ready: false };
  assert.deepEqual(coverageReport(releases, [draft], {}, '7.3.0').missing, [endpoint]);
  const missing = case_();
  missing.steps[0].fixture = 'missing';
  assert.ok(validateCase(missing, {}).some((error) => error.includes('missing argument')));
  missing.steps[0].args = null;
  assert.equal(coverageReport(releases, [missing], {}, '7.3.0').covered, 0);
});

test('new endpoint and new feature obligations both fail coverage until explicit assertion evidence exists', () => {
  const report = coverageReport(releases, [case_()], {}, '7.4.0');
  assert.deepEqual(report.missing, ['endpoint:models.retrieve', 'new-model']);
  const feature = case_();
  feature.id = 'feature';
  feature.since = '7.4.0';
  feature.covers = ['new-model'];
  assert.ok(validateCase(feature, {}).some((error) => error.includes('missing feature evidence')));
  feature.evidence = { 'new-model': ['list'] };
  assert.deepEqual(validateCase(feature, {}), []);
  assert.ok(!coverageReport(releases, [case_(), feature], {}, '7.3.0').runnable.includes('feature'));
});

test('removal of a baseline endpoint fails even when all current endpoints have cases', () => {
  const removed = [{ ...releases[0], baselineMissing: ['old.method'] }];
  const report = coverageReport(removed, [case_()], {}, '7.3.0');
  assert.equal(report.missing.length, 0);
  assert.equal(report.complete, false);
});

test('declaring coverage without exercising the endpoint is rejected', () => {
  const wrong = case_();
  wrong.covers = ['endpoint:models.delete'];
  assert.ok(validateCase(wrong, {}).some((error) => error.includes('endpoint not exercised')));
});

test('invalid options indexes and empty assertions cannot pass preflight', () => {
  const wrong = case_();
  wrong.steps[0].optionsIndex = undefined;
  wrong.steps[0].assertions = [];
  assert.ok(validateCase(wrong, {}).some((error) => error.includes('request-options')));
  assert.ok(validateCase(wrong, {}).some((error) => error.includes('no response assertions')));
});

test('duplicate case IDs and unsafe SDK paths are rejected', () => {
  assert.throws(() => applicableCases([case_(), case_()], '7.3.0'), /Duplicate case/);
  const wrong = case_();
  wrong.steps[0].method = 'models.constructor';
  assert.ok(validateCase(wrong, {}).some((error) => error.includes('invalid SDK method')));
});

test('feature cases from earlier releases remain required on every later version', () => {
  const withFeatures = [
    { ...releases[0], requirements: [{ id: 'baseline-feature' }] },
    releases[1],
  ];
  assert.ok(coverageReport(withFeatures, [case_()], {}, '7.4.0').missing.includes('baseline-feature'));
});

test('new-release gaps fail coverage but do not suppress an already configured baseline regression suite', () => {
  const plan = livePlan(releases, [case_()], {}, '7.4.0');
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.cases.map((entry) => entry.id), ['models']);
  assert.equal(plan.report.complete, false);
  assert.deepEqual(plan.report.missing, ['endpoint:models.retrieve', 'new-model']);
  const missingBaseline = livePlan(releases, [{ ...case_(), ready: false }], {}, '7.4.0');
  assert.equal(missingBaseline.blocked, true);
  assert.deepEqual(missingBaseline.cases, []);
});

test('generated catalogs include every baseline endpoint and explicit drafts for every new release obligation', async () => {
  const { releases: actual } = await readJSON('releases.json');
  const catalog = await readJSON('cases/catalog.json');
  const builtins = await readJSON('cases/builtins.json');
  const all = [...catalog, ...builtins];
  assert.equal(actual[0].version, '7.3.0');
  assert.ok(actual[0].methods.includes('responses.create'), 'api.md omits stable Responses; source discovery must include it');
  const endpointCases = new Set(catalog.flatMap((entry) => entry.covers));
  for (const entry of catalog.filter((entry) => entry.method)) {
    assert.ok(entry.steps.length, `${entry.id}: missing generated live invocation`);
    assert.ok(entry.steps[0].assertions.length, `${entry.id}: missing generated response assertions`);
    assert.ok(Number.isInteger(entry.steps[0].optionsIndex), `${entry.id}: missing request-options position`);
  }
  for (const release of actual) {
    for (const method of release.methods) assert.ok(endpointCases.has(`endpoint:${method}`), `${release.version}: ${method}`);
    for (const requirement of release.requirements) assert.ok(endpointCases.has(requirement.id), requirement.id);
  }
  const fixtureTemplate = await readJSON('fixtures/template.json');
  for (const entry of builtins) {
    assert.deepEqual(validateCase(entry, fixtureTemplate), [], entry.id);
    for (const covered of entry.covers) assert.ok(endpointCases.has(covered), covered);
  }
});
