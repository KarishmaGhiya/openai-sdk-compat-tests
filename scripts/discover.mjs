import { mkdir, access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseline, compareVersions, exec, npm, readJSON, root, stableVersions, writeJSON } from '../lib/io.mjs';
import { digest, diffSurface, inventory } from '../lib/inventory.mjs';

const repository = join(root, '.cache', 'upstream');
const offline = process.env.DISCOVERY_OFFLINE === 'true';
await mkdir(join(root, '.cache'), { recursive: true });
const git = (args) => exec('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 240_000 });
try {
  await access(join(repository, '.git'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (offline) throw new Error('Offline discovery needs a previously fetched .cache/upstream checkout.');
  await git(['clone', '--quiet', '--depth=1', '--no-checkout', 'https://github.com/openai/openai-node.git', repository]);
}

const registryArgs = process.env.NPM_REGISTRY ? [`--registry=${process.env.NPM_REGISTRY}`] : [];
let tags;
let published;
let prior;
try {
  prior = await readJSON('releases.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (offline) {
  if (!prior) throw new Error('Offline discovery requires releases.json from an earlier online discovery.');
  tags = new Map(prior.releases.map((release) => [release.version, release.sha]));
  published = new Set(prior.releases.filter((release) => release.published).map((release) => release.version));
  console.log('OFFLINE: using previously recorded tags and publication status, not checking for new releases.');
} else {
  const { stdout: remote } = await git(['ls-remote', '--tags', 'https://github.com/openai/openai-node.git', 'refs/tags/v*']);
  tags = new Map(remote.trim().split('\n').map((line) => line.trim().split(/\s+/))
    .filter(([, ref]) => /^refs\/tags\/v\d+\.\d+\.\d+$/.test(ref))
    .map(([sha, ref]) => [ref.slice('refs/tags/v'.length), sha]));
  const { stdout } = await npm(['view', 'openai', 'versions', '--json', ...registryArgs]);
  published = new Set(stableVersions(JSON.parse(stdout)));
  const missingTags = [...published].filter((version) => !tags.has(version));
  if (missingTags.length) throw new Error(`Published SDK versions have no source tags: ${missingTags.join(', ')}`);
}
for (const release of prior?.releases ?? []) {
  if (!tags.has(release.version) || tags.get(release.version) !== release.sha) {
    throw new Error(`Previously recorded tag v${release.version} disappeared or changed; manual review required.`);
  }
}
const tagged = stableVersions([...tags.keys()]);
if (!published.has(baseline) || !tags.has(baseline)) throw new Error(`Baseline ${baseline} must be tagged and published.`);
const versions = tagged;
if (!offline) {
  await git(['-C', repository, 'fetch', '--quiet', '--depth=1', 'origin',
    ...versions.map((version) => `refs/tags/v${version}:refs/tags/v${version}`)]);
}

let cases = [];
try {
  cases = await readJSON('cases/catalog.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const existing = new Set(cases.map((entry) => entry.id));
function addCase(entry) {
  if (existing.has(entry.id)) {
    // Preserve partially authored cases as well as fully reviewed ones.
    return;
  }
  cases.push({
    ...entry, ready: false,
    steps: entry.method ? [{
      id: 'request', method: entry.method, fixture: entry.id,
      optionsIndex: entry.optionsIndex, assertions: entry.assertions,
      ...(entry.capture ? { capture: entry.capture } : {}),
    }] : [],
  });
  existing.add(entry.id);
}
const releases = [];
let previous;
const baselineMethods = new Set();
for (const version of versions) {
  await git(['-C', repository, 'checkout', '--quiet', '--detach', `v${version}`]);
  const current = await inventory(repository, version);
  await writeJSON(`.cache/inventories/${version}.json`, current);
  const requirements = [];
  const changes = previous ? diffSurface(previous, current) : undefined;
  if (!previous) {
    for (const method of current.methods) {
      baselineMethods.add(method.id);
      addCase({
        id: `endpoint:${method.id}`, since: version, covers: [`endpoint:${method.id}`],
        title: `Live ${method.id}`, method: method.id, endpoint: method.endpoint,
        signature: method.signature, source: method.source, optionsIndex: method.optionsIndex,
        assertions: method.assertions, ...(method.capture ? { capture: method.capture } : {}),
      });
    }
    requirements.push(...current.features);
    if (requirements.length) addCase({
      id: `features:${version}`, since: version,
      covers: requirements.map((entry) => entry.id),
      title: `Live regression cases for ${version} features`,
      requirements,
    });
  } else {
    for (const method of changes.addedMethods) {
      addCase({
        id: `endpoint:${method.id}`, since: version, covers: [`endpoint:${method.id}`],
        title: `Live ${method.id}`, method: method.id, endpoint: method.endpoint,
        signature: method.signature, source: method.source, optionsIndex: method.optionsIndex,
        assertions: method.assertions, ...(method.capture ? { capture: method.capture } : {}),
      });
    }
    for (const method of changes.changedMethods) {
      requirements.push({ id: `method:${version}:${method.id}`, description: `Changed ${method.id}: ${method.endpoint} ${method.signature}` });
    }
    for (const member of changes.changedSurface) {
      requirements.push({ id: `surface:${version}:${member.key}:${member.hash.slice(0, 12)}`, description: `${member.change}: ${member.key}` });
    }
    // Removals are explicit compatibility failures, never silently excluded.
    for (const member of changes.removedSurface) {
      requirements.push({ id: `removed:${version}:${member}`, description: `Removed public surface: ${member}` });
    }
    requirements.push(...current.features);
    // One draft per release can contain multiple feature scenarios/obligations.
    if (requirements.length) {
      addCase({
        id: `features:${version}`, since: version,
        covers: requirements.map((entry) => entry.id),
        title: `Live regression cases for ${version} additions and changes`,
        requirements,
      });
    }
  }
  releases.push({
    version, sha: tags.get(version), published: published.has(version),
    methods: current.methods.map((method) => method.id),
    requirements, removedMethods: changes?.removedMethods.map((method) => method.id) ?? [],
    baselineMissing: [...baselineMethods].filter((id) => !current.methods.some((method) => method.id === id)),
  });
  previous = current;
  console.log(`${version}: ${current.methods.length} endpoints, ${requirements.length} feature obligations${published.has(version) ? '' : ' (not published in configured registry)'}`);
}
cases.sort((a, b) => compareVersions(a.since, b.since) || a.id.localeCompare(b.id));
await writeJSON('cases/catalog.json', cases);
await writeJSON('releases.json', { baseline, releases, fingerprint: digest(JSON.stringify(releases)) });

let fixtures = {};
try {
  fixtures = await readJSON('fixtures/template.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const entry of cases) {
  if (!(entry.id in fixtures)) {
    fixtures[entry.id] = {
      args: null,
      note: entry.method
        ? `Supply valid arguments for ${entry.method}${entry.signature}; use only dedicated disposable test resources.`
        : 'Configure reviewed release-specific scenarios in cases/catalog.json, then add their fixture keys here.',
    };
  }
}
await writeJSON('fixtures/template.json', fixtures);
const latest = releases.filter((release) => release.published).at(-1).version;
const newlyPublished = releases.filter((release) => release.published &&
  !prior?.releases.some((old) => old.version === release.version && old.published));
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT,
    `latest=${latest}\nnew_published=${newlyPublished.length > 0}\nfirst_new=${newlyPublished[0]?.version ?? ''}\n`);
}
console.log(`Latest tagged: ${versions.at(-1)}; latest available from configured registry: ${latest}`);
