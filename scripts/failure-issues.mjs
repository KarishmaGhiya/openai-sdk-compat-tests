import { createSign } from 'node:crypto';
import { responsesIssueFindings } from '../lib/compat-summary.mjs';

const base64url = (value) => Buffer.from(value).toString('base64url');

// Exchanges the GitHub App private key for a one-hour installation token restricted to the issue repositories and Issues: write.
export async function appInstallationToken({ clientId, privateKey, repos, fetchImpl = fetch, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat, exp: iat + 540, iss: clientId }))}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
  const call = async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub App ${method} ${path.replace(/\d+/g, '{id}')} failed with HTTP ${response.status}`);
    return response.json();
  };
  const targets = [...new Set(Object.values(repos))];
  const owners = new Set(targets.map((repo) => repo.split('/')[0]));
  if (owners.size !== 1) throw new Error('Issue repositories must share one owner and App installation');
  const installation = await call('GET', `repos/${targets[0]}/installation`);
  const { token } = await call('POST', `app/installations/${installation.id}/access_tokens`, {
    repositories: targets.map((repo) => repo.split('/')[1]), permissions: { issues: 'write' },
  });
  return token;
}

export async function revokeInstallationToken(token, fetchImpl = fetch) {
  await fetchImpl('https://api.github.com/installation/token', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  }).catch(() => {});
}

export const issueLabel = 'sdk-compat';
export const defaultIssueRepos = {
  openapi: 'KarishmaGhiya/openai-openapi',
  sdk: 'KarishmaGhiya/openai-node',
  azure: 'KarishmaGhiya/azure-rest-api-specs',
};

function client(token, fetchImpl) {
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path.split('?')[0]} failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  };
}

async function paged(api, path, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

// Files or updates one issue per categorized failure and returns { [caseLogMarker]: issueUrl }.
export async function fileFailureIssues({ report, token, repos = defaultIssueRepos, fetchImpl = fetch, log = console.log }) {
  const api = client(token, fetchImpl);
  const links = {};
  const issuesByRepo = new Map();
  for (const finding of responsesIssueFindings(report)) {
    const repo = repos[finding.kind];
    try {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`No valid target repository for ${finding.kind}`);
      if (!issuesByRepo.has(repo)) {
        await api('POST', `repos/${repo}/labels`, { name: issueLabel, color: 'd93f0b', description: 'Found by openai-sdk-compat-tests' })
          .catch((error) => { if (error.status !== 422) throw error; });
        issuesByRepo.set(repo, (await paged(api, `repos/${repo}/issues?labels=${issueLabel}&state=all`))
          .filter((issue) => !issue.pull_request));
      }
      const marker = `<!-- sdk-compat-fingerprint: ${finding.fingerprint} -->`;
      const existing = issuesByRepo.get(repo).find((issue) => issue.body?.includes(marker));
      let url;
      if (existing) {
        const comments = await paged(api, `repos/${repo}/issues/${existing.number}/comments`);
        const known = [existing.body, ...comments.map((comment) => comment.body)].join('\n');
        const newRows = finding.rows.filter((_, index) => !known.includes(finding.evidenceMarkers[index]));
        if (existing.state === 'closed') {
          await api('PATCH', `repos/${repo}/issues/${existing.number}`, { state: 'open' });
        }
        if (newRows.length || existing.state === 'closed') {
          const prefix = existing.state === 'closed' ? 'Reopened: this failure recurred.\n\n' : '';
          await api('POST', `repos/${repo}/issues/${existing.number}/comments`, {
            body: `${prefix}${finding.evidenceComment(report.links?.run, newRows.length ? newRows : finding.rows)}`,
          });
        }
        url = existing.html_url;
        log(`Reused ${repo}#${existing.number} for ${finding.feature}${newRows.length ? ' (added new evidence)' : ''}.`);
      } else {
        const created = await api('POST', `repos/${repo}/issues`, { title: finding.title, body: finding.body, labels: [issueLabel] });
        issuesByRepo.get(repo).push(created);
        url = created.html_url;
        log(`Created ${repo}#${created.number} for ${finding.feature}.`);
      }
      for (const caseMarker of finding.markers) links[caseMarker] = url;
    } catch (error) {
      log(`::warning::Could not file or update an issue for ${finding.feature} (${error.message}).`);
    }
  }
  return links;
}
