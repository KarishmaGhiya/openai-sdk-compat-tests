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
const responsesOnly = process.argv.includes('--responses-only');
const registryArgs = process.env.NPM_REGISTRY ? [`--registry=${process.env.NPM_REGISTRY}`] : [];
try {
  for (const release of selected) {
    console.log(`\n=== SDK ${release.version} ===`);
    let phase = 'install';
    try {
      await npm(['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund',
        `openai@${release.version}`, ...registryArgs]);
      phase = 'responses-contracts';
      if (responsesOnly) await exec(process.execPath, ['scripts/responses-catalog.mjs'], { cwd: root, timeout: 120_000 });
      await exec(process.execPath, ['scripts/responses-report.mjs'], { cwd: root, timeout: 120_000 })
        .catch((error) => { if (error.code !== 1) throw error; });
      const report = await readJSON('reports/responses-compatibility.json');
      if (report.packages[0].version !== release.version) throw new Error('Responses version report was not refreshed.');
      await writeJSON(`reports/responses-${release.version}.json`, report);
      await exec(process.execPath, ['--test', 'tests/responses-contract.test.mjs'], {
        cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000,
      });
      if (responsesOnly) {
        summary.push({ version: release.version, status: 'passed', phase });
        await writeJSON('reports/responses-versions.json', summary);
        console.log(`SDK ${release.version}: Responses contracts passed.`);
        continue;
      }
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
    await writeJSON(responsesOnly ? 'reports/responses-versions.json' : 'reports/versions.json', summary);
  }
} finally {
  // Restore pinned dependencies after successful runs and handled failures.
  await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...registryArgs]);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## SDK ${responsesOnly ? 'Responses offline' : 'live'} compatibility\n\n| Version | Result | Phase |\n|---|---|---|\n${summary.map((entry) => `| ${entry.version} | ${entry.status} | ${entry.phase ?? 'live'} |`).join('\n')}\n`);
}
if (summary.some((entry) => entry.status === 'failed')) process.exitCode = 1;
