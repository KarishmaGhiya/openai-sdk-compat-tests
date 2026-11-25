import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../lib/io.mjs';

const stable = /^\d+\.\d+\.\d+$/;

export function releasePair(versions, latest) {
  if (!stable.test(latest ?? '')) throw new Error(`Latest dist-tag is not a stable version: ${latest}`);
  const previous = versions.filter((version) => stable.test(version) && compareVersions(version, latest) < 0)
    .sort(compareVersions).at(-1);
  if (!previous) throw new Error(`No stable release precedes ${latest}`);
  return { previous, latest };
}

export async function fetchVersions(env = process.env) {
  const registry = (env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const response = await fetch(`${registry}/openai`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const packument = await response.json();
  return { versions: Object.keys(packument.versions ?? {}), latest: packument['dist-tags']?.latest };
}

export async function main(env = process.env) {
  const { versions, latest } = await fetchVersions(env);
  const pair = releasePair(versions, latest);
  console.log(`Latest openai release ${pair.latest}; previous ${pair.previous}.`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `latest=${pair.latest}\nprevious=${pair.previous}\n`);
  return pair;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
