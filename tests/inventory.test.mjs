import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { changelogFeatures, diffSurface, parseMethods, parseSurface, resourceMethods } from '../lib/inventory.mjs';
import { compareVersions, root, stableVersions } from '../lib/io.mjs';

test('stable release selection sorts numerically and includes later major versions', () => {
  assert.deepEqual(stableVersions(['7.30.0', '7.3.0', '7.4.0', '7.10.0', '7.2.0', '7.31.0-beta.1', '8.0.0', 'garbage']),
    ['7.3.0', '7.4.0', '7.10.0', '7.30.0', '8.0.0']);
  assert.ok(compareVersions('7.4.0', '7.30.0') < 0);
});

test('api.md parser preserves nested resource methods, verbs, and paths', () => {
  const methods = parseMethods('<code title="get /responses/{id}/input_items">client.beta.responses.inputItems.<a href="./src/resources/items.ts">list</a>(id, { ...params }) -> Page</code>');
  assert.deepEqual(methods, [{
    id: 'beta.responses.inputItems.list', endpoint: 'get /responses/{id}/input_items',
    source: 'src/resources/items.ts', signature: '(id, { ...params }) -> Page',
  }]);
  assert.throws(() => parseMethods('<code title="get /models">client.models.list()</code>'), /format changed/);
});

test('type diffs detect enum additions, optional request fields, and removed fields without treating comments as changes', () => {
  const file = 'src/resources/demo.ts';
  const before = parseSurface('export type Model = "a"; export interface Params { model: Model; obsolete?: string; }', file);
  const same = parseSurface('/** documentation */ export type Model = "a"; export interface Params { model: Model; obsolete?: string; }', file);
  assert.deepEqual(before, same);
  const after = parseSurface('export type Model = "a" | "b"; export interface Params { model: Model; newOption?: boolean; }', file);
  const diff = diffSurface({ methods: [], surface: before }, { methods: [], surface: after });
  assert.deepEqual(diff.changedSurface.map((entry) => entry.key).sort(), [`${file}#Model`, `${file}#Params.newOption`]);
  assert.deepEqual(diff.removedSurface, [`${file}#Params.obsolete`]);
});

test('helpers track public signatures without making implementation-body edits into type additions', () => {
  const left = parseSurface('export class Helper { run(x: string): number { return 1; } private secret(): void {} }', 'helper.ts');
  const right = parseSurface('export class Helper { run(x: string): number { return 2; } private secret(): void {} }', 'helper.ts');
  assert.deepEqual(left, right);
  assert.deepEqual(Object.keys(left), ['helper.ts#Helper.run']);
  assert.deepEqual(parseSurface('interface Internal { value: string; } type PrivateAlias = number; class InternalHelper { run(): void {} }', 'internal.ts'), {});
});

test('feature extraction handles historical unlinked headings, linked headings, CRLF, and missing sections', () => {
  const historical = '## 7.4.0 (2026-08-03)\r\n\r\n### Features\r\n\r\n* **api:** new field ([abc](url))\r\n\r\n### Bug Fixes\r\n* ignored\r\n\r\n## 7.3.0 (date)\r\n';
  const modern = '## [7.4.0](url) (date)\n### Features\n* **api:** new field ([abc](url))\n## [7.3.0](url)\n';
  assert.deepEqual(changelogFeatures(historical, '7.4.0'), changelogFeatures(modern, '7.4.0'));
  assert.equal(changelogFeatures(historical, '7.4.0')[0].description, '**api:** new field');
  assert.throws(() => changelogFeatures(historical, '7.5.0'), /Missing changelog/);
});

test('source traversal finds undocumented endpoints, follows nested resources, and uses implementation options arity', async () => {
  await mkdir(join(root, '.cache'), { recursive: true });
  const directory = await mkdtemp(join(root, '.cache', 'inventory-test-'));
  const client = join(directory, 'client.ts');
  try {
    await writeFile(client, `
      class APIResource { _client: any; }
      interface Model { id: string; object: 'model'; created: number; }
      class APIPromise<T> { data!: T; }
      class Models extends APIResource {
        list(options?: object): APIPromise<Model>;
        list(query: object, options?: object): APIPromise<Model>;
        list(query?: object, options?: object): APIPromise<Model> { return this._client.get('/models', options); }
        undocumented(options?: object): APIPromise<Model> { return this._client.post('/extra', options); }
        helper(): string { return 'not an endpoint'; }
      }
      class Group { models = new Models(); }
      export class OpenAI { group = new Group(); }
    `);
    const program = ts.createProgram([client], { target: ts.ScriptTarget.ESNext, noEmit: true });
    const methods = resourceMethods(program, client, directory);
    assert.deepEqual(methods.map((method) => method.id), ['group.models.list', 'group.models.undocumented']);
    assert.equal(methods[0].optionsIndex, 1);
    assert.equal(methods[1].endpoint, 'post /extra');
    assert.ok(methods[0].assertions.some((rule) => rule.path === 'object' && rule.value === 'model'));
    assert.ok(methods[0].assertions.some((rule) => rule.path === 'created' && rule.value === 'number'));
  } finally {
    await rm(directory, { recursive: true });
  }
});
