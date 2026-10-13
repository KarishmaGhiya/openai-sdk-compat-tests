import { appendFile } from 'node:fs/promises';
import { compareVersions, exec, npm, readJSON, root, writeJSON } from '../lib/io.mjs';

const { releases, baseline } = await readJSON('releases.json');
const published = releases.filter((release) => release.published);
const from = process.env.FROM_VERSION ?? baseline;
const to = process.env.TO_VERSION ?? published.at(-1).version;
if (!published.some((release) => release.version === from) || !published.some((release) => release.version === to)) {
  throw new Error('FROM_VERSION and TO_VERSION must be published discovered releases.');
}
if (compareVersions(from, to) > 0) throw new Error('FROM_VERSION is greater than TO_VERSION.');
if (process.env.LIVE_CASES) throw new Error('Partial case selections cannot be used for version compatibility runs.');
const selected = published.filter((release) => compareVersions(release.version, from) >= 0 && compareVersions(release.version, to) <= 0);
const summary = [];
const registryArgs = process.env.NPM_REGISTRY ? [`--registry=${process.env.NPM_REGISTRY}`] : [];
for (const release of selected) {
  console.log(`\n=== SDK ${release.version} ===`);
  let phase = 'install';
  try {
    await npm(['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund',
      `openai@${release.version}`, ...registryArgs]);
    phase = 'live';
    const { stdout, stderr } = await exec(process.execPath, ['scripts/live.mjs'], {
      cwd: root, env: { ...process.env, SDK_VERSION: release.version },
      maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60_000,
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    summary.push({ version: release.version, status: 'passed' });
  } catch (error) {
    // Do not leak raw npm/API error messages or fixture contents to artifacts.
    console.error(`SDK ${release.version} failed during ${phase}; exit code ${error.code ?? 'unknown'}.`);
    // The live runner emits only configuration failures and redacted API outcomes.
    if (phase === 'live') {
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
    }
    summary.push({ version: release.version, status: 'failed', phase, exitCode: error.code ?? null });
  }
  await writeJSON('reports/versions.json', summary);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## SDK live compatibility\n\n| Version | Result |\n|---|---|\n${summary.map((entry) => `| ${entry.version} | ${entry.status} |`).join('\n')}\n`);
}
if (summary.some((entry) => entry.status === 'failed')) process.exitCode = 1;
