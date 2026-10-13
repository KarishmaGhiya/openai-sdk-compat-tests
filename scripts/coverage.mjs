import { coverageReport } from '../lib/coverage.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';

const { releases } = await readJSON('releases.json');
const catalog = await readJSON('cases/catalog.json');
const builtins = await readJSON('cases/builtins.json');
const fixtures = await readJSON(process.env.LIVE_FIXTURES ?? 'fixtures/template.json');
const version = process.env.SDK_VERSION ?? releases.filter((release) => release.published).at(-1).version;
const report = coverageReport(releases, [...catalog, ...builtins], fixtures, version);
await writeJSON(`reports/coverage-${version}.json`, report);
console.log(`${version}: ${report.covered}/${report.required} obligations covered; ${report.missing.length} missing; ${report.baselineMissing.length} removed baseline APIs.`);
if (!report.complete) process.exitCode = 1;
