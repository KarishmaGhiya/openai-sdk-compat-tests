import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const root = resolve(import.meta.dirname, '..');
export const baseline = '7.3.0';
export const exec = promisify(execFile);

export async function readJSON(path) {
  const text = await readFile(resolve(root, path), 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path}; content redacted.`);
  }
}

export async function readOptionalJSON(path, fallback) {
  try {
    return await readJSON(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

export async function packageVersion(name) {
  return (await readJSON(`node_modules/${name}/package.json`)).version;
}

export async function packageVersions(names) {
  const versions = {};
  for (const name of names) versions[name] = await packageVersion(name);
  return versions;
}

export async function appendStepSummary(text, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text);
}

// Resolves a relative path, or returns undefined when it escapes the directory.
export function insideDirectory(directory, path) {
  const file = resolve(directory, path);
  const rel = relative(directory, file);
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ? undefined : file;
}

export async function writeJSON(path, value) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function stableVersions(versions, minimum = baseline) {
  return versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .filter((version) => compareVersions(version, minimum) >= 0)
    .sort(compareVersions);
}

export async function npm(args) {
  // npm's executable is a .cmd shim on Windows; invoke npm's JS entry point instead.
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('Run this command through npm run so npm_execpath is available.');
  return exec(process.execPath, [cli, ...args], {
    cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 240_000,
  });
}
