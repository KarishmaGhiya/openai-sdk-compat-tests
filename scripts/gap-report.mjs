import { appendFile } from 'node:fs/promises';
import { coverageReport } from '../lib/coverage.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';

const { releases } = await readJSON('releases.json');
const cases = [...await readJSON('cases/catalog.json'), ...await readJSON('cases/builtins.json')];
const fixtures = await readJSON('fixtures/template.json');
const reports = releases.map((release) => coverageReport(releases, cases, fixtures, release.version));
await writeJSON('reports/gaps.json', reports);
const summary = `## Coverage inventory (not live-test results)\n\n| Version | Published | Covered / required | Missing baseline endpoints |\n|---|---|---|---|\n${
  reports.map((report, index) => `| ${report.version} | ${releases[index].published} | ${report.covered} / ${report.required} | ${report.baselineMissing.length} |`).join('\n')
}\n\nDrafts are not coverage. Review fixtures and assertion-to-feature evidence before setting ready=true.\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
