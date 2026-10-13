import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { readJSON } from '../lib/io.mjs';

test('every inventoried endpoint resolves on the installed published SDK without making requests', async () => {
  const version = (await readJSON('node_modules/openai/package.json')).version;
  const { releases } = await readJSON('releases.json');
  const release = releases.find((entry) => entry.version === version);
  assert.ok(release, `Undiscovered installed version ${version}`);
  const client = new OpenAI({
    apiKey: 'offline-test-key', adminAPIKey: 'offline-admin-key',
    fetch: async () => { throw new Error('Inventory validation must not perform network requests'); },
  });
  const missing = release.methods.filter((method) => {
    let value = client;
    for (const part of method.split('.')) value = value?.[part];
    return typeof value !== 'function';
  });
  assert.deepEqual(missing, [], `SDK ${version} disagrees with tagged source inventory`);
});
