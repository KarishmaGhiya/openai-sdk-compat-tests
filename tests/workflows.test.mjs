import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { root } from '../lib/io.mjs';

for (const name of ['ci.yml', 'releases.yml']) {
  test(`${name} is valid GitHub Actions YAML with resolvable job prerequisites and pinned actions`, async () => {
    const document = YAML.parseDocument(await readFile(join(root, '.github', 'workflows', name), 'utf8'), { uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    const workflow = document.toJS();
    assert.ok(workflow.on);
    assert.ok(Object.keys(workflow.jobs).length);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const prerequisite of [job.needs ?? []].flat()) {
        assert.ok(prerequisite in workflow.jobs, `${id} depends on nonexistent ${prerequisite}`);
      }
      for (const step of job.steps) {
        assert.ok(Boolean(step.run) !== Boolean(step.uses), `${id}: step must have either run or uses`);
        if (step.uses) assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/, `${id}: action must be immutable`);
      }
    }
  });
}
