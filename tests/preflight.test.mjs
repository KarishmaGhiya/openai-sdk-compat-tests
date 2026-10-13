import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from '../lib/io.mjs';
import { readJSON, root } from '../lib/io.mjs';

test('full live execution fails missing coverage before credential authorization or client construction', async () => {
  const version = (await readJSON('node_modules/openai/package.json')).version;
  await assert.rejects(exec(process.execPath, ['scripts/live.mjs'], {
    cwd: root,
    env: {
      ...process.env, SDK_VERSION: version,
      LIVE_FIXTURES: 'fixtures/template.json', LIVE_CASES: '',
      ALLOW_LIVE_API: 'false', OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://not-openai.invalid',
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^Error: Coverage incomplete: .*No billable requests made\./m);
    return true;
  });
});

test('duplicate/empty partial selections cannot produce success-shaped results', async () => {
  const version = (await readJSON('node_modules/openai/package.json')).version;
  for (const selection of ['smoke:models,smoke:models', ',']) {
    await assert.rejects(exec(process.execPath, ['scripts/live.mjs'], {
      cwd: root, env: {
        ...process.env, SDK_VERSION: version, LIVE_FIXTURES: 'fixtures/template.json',
        LIVE_CASES: selection, OPENAI_API_KEY: '', ALLOW_LIVE_API: 'false',
      },
    }), (error) => {
      assert.match(error.stderr, /^Error: LIVE_CASES must contain nonempty, distinct/m);
      return true;
    });
  }
});
