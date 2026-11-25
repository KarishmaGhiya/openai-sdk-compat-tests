import { pathToFileURL } from 'node:url';
import { compareVersions } from '../lib/io.mjs';
import { changelogFeatures } from '../lib/inventory.mjs';
import { fetchVersions, releasePair } from './release-watch.mjs';

export const issueLabel = 'sdk-release-tests';
export const copilotAssignee = 'copilot-swe-agent[bot]';
const stable = /^\d+\.\d+\.\d+$/;

export const issueTitle = (version) => `Add tests for openai ${version}`;

export function releasesNeedingTests(versions, latest, from) {
  if (!stable.test(from ?? '')) throw new Error(`RELEASE_TESTS_FROM must be an exact version, got: ${from}`);
  return versions.filter((version) => stable.test(version) &&
    compareVersions(version, from) >= 0 && compareVersions(version, latest) <= 0).sort(compareVersions);
}

export function releaseTestIssue({ version, previous, features }) {
  const rows = features.map((feature) => `| \`${feature.id}\` | ${feature.description.replaceAll('|', '\\|')} |`);
  const body = `openai-node **${version}** is published on npm (previous stable release: ${previous}).
Its changelog lists these features. After discovery, each one is a coverage obligation in \`cases/catalog.json\`.

| Obligation | Feature |
|---|---|
${rows.join('\n')}

- Changelog: https://github.com/openai/openai-node/blob/v${version}/CHANGELOG.md
- Source diff: https://github.com/openai/openai-node/compare/v${previous}...v${version}

## What to do

1. Run \`npm ci --ignore-scripts\`, then \`NPM_REGISTRY=https://registry.npmjs.org npm run discover\` to add ${version} to \`releases.json\`, \`cases/catalog.json\`, and \`fixtures/template.json\`. Discovery never overwrites reviewed cases.
2. For **each** obligation above, complete the generated release-feature case for ${version} in \`cases/catalog.json\`: add steps that exercise the changed behavior, assertions that would fail without it, and an \`evidence\` map from the obligation ID to those step IDs (see "Configure real API tests" in \`README.md\`). Put new fixture argument slots in \`fixtures/template.json\` only; never commit real values.
3. If a feature changes Responses or Azure-relevant request/response shapes, also add offline contract coverage (\`lib/responses-contract.mjs\` with \`tests/responses-contract.test.mjs\`, or the Azure contracts under \`compat/\`) that runs against an injected transport.
4. Set \`ready: true\` only on cases whose steps, assertions, and evidence are complete. Leave cases that need account-specific fixtures, admin permissions, or restricted features as \`ready: false\` and say why in the PR description.
5. Run \`npm test\`; it must pass. Do not set \`ALLOW_LIVE_API\`, call paid APIs, or add credentials. Do not change the pinned \`openai\` / \`openai-current\` versions in \`package.json\`.
6. In the PR description, list every obligation ID with the case and step IDs that cover it, or the reason it still needs a human.`;
  return { title: issueTitle(version), body };
}

async function github(token, path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept, authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} returned HTTP ${response.status}`);
  return accept.endsWith('raw') ? response.text() : response.json();
}

export async function main(env = process.env) {
  const token = env.COPILOT_AGENT_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token) throw new Error('COPILOT_AGENT_TOKEN is not set');
  const max = Number(env.RELEASE_TESTS_MAX ?? 3);
  const { versions, latest } = await fetchVersions(env);
  const existing = new Set((await github(token, `/repos/${repo}/issues?labels=${issueLabel}&state=all&per_page=100`))
    .map((issue) => issue.title));
  let created = 0;
  for (const version of releasesNeedingTests(versions, latest, env.RELEASE_TESTS_FROM)) {
    if (existing.has(issueTitle(version))) continue;
    const changelog = await github(token, `/repos/openai/openai-node/contents/CHANGELOG.md?ref=v${version}`,
      { accept: 'application/vnd.github.raw' });
    const features = changelogFeatures(changelog, version);
    if (!features.length) {
      console.log(`openai ${version} lists no features; no test request needed.`);
      continue;
    }
    if (created >= max) {
      console.log(`::warning::Reached RELEASE_TESTS_MAX=${max}; openai ${version} will be requested on the next run.`);
      break;
    }
    const issue = releaseTestIssue({ version, previous: releasePair(versions, version).previous, features });
    const result = await github(token, `/repos/${repo}/issues`, { method: 'POST', body: {
      ...issue, labels: [issueLabel], assignees: [copilotAssignee],
      agent_assignment: { target_repo: repo, base_branch: 'main' },
    } });
    created += 1;
    console.log(`::notice::Asked Copilot to add tests for openai ${version}: ${result.html_url}`);
  }
  if (!created) console.log('No new releases need test requests.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
