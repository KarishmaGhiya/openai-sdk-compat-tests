import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLiveSummary, renderResponsesSummary, renderResponsesCaseLog, responsesFailureCategory } from '../lib/compat-summary.mjs';

test('Responses-core renders only a linked colored matrix with evidence-qualified categories', () => {
  const source = 'https://github.com/example/tests/blob/abc/lib/responses-live.mjs#L176';
  const test = 'https://github.com/example/tests/blob/abc/lib/responses-live.mjs#L272';
  const logs = 'https://github.com/example/tests/actions/runs/123/job/456#step:12:1';
  const rows = [
    { feature: 'method:create', status: 'passed' },
    { feature: 'method:inputTokens.count', status: 'failed', error: {
      status: 400, operation: 'responses.inputTokens.count', serviceSignals: ['unsupported', 'model'],
      message: 'SECRET-MESSAGE', rootCause: 'SECRET-CAUSE',
    } },
    { feature: 'method:inputItems.list', status: 'failed', error: { status: 404, operation: 'responses.inputItems.list' } },
    { feature: 'method:compact', status: 'sdk-unavailable' },
    { feature: 'method:parse', status: 'failed', error: { name: 'AssertionError', status: null } },
    { feature: 'method:retrieve', status: 'missing-fixture' },
    { feature: 'method:cancel', status: 'declared-unsupported' },
    { feature: 'method:stream', status: 'failed', error: { status: null } },
  ].map((row) => ({ suite: 'responses', provider: 'azure', client: 'baseline-azure-v1', version: '7.3.0', ...row }));
  const summary = renderLiveSummary({
    summaryMode: 'responses-core', live: true, links: { source, logs, tests: { 'method:inputTokens.count': test } },
    results: rows,
  });
  assert.ok(summary.trim().split('\n').every((line) => line.startsWith('|')));
  assert.ok(summary.includes(`[Create a text response](${source})`));
  assert.ok(summary.includes(`[Count input tokens](${test})`));
  assert.ok(summary.includes('| \u{1f7e2} Passed |'), 'passed cells are not linked');
  assert.ok(!summary.includes(`[\u{1f7e2} Passed]`));
  assert.ok(summary.includes(`[\u{1f534} Failed (HTTP 400); API rejection; cause unconfirmed](${logs}`));
  assert.match(summary, /HTTP 404.*Lookup returned not found/);
  assert.match(summary, /SDK surface gap/);
  assert.match(summary, /Contract mismatch; spec\/SDK\/API unconfirmed/);
  assert.match(summary, /Runtime failure; cause unconfirmed/);
  assert.match(summary, /Not run: missing fixture/);
  assert.match(summary, /Declared unsupported \(not verified\)/);
  assert.doesNotMatch(summary, /SECRET-|<details>|###|All \d+ selected/);
  const log = renderResponsesCaseLog(rows[1]);
  assert.match(log, /Count input tokens/);
  assert.match(log, /Failed step: Count input tokens/);
  assert.match(log, /Suspected Azure model\/service support limitation \(unconfirmed/);
  assert.doesNotMatch(log, /SECRET-/);
});

test('Responses-core setup and unsafe or missing links never create misleading passes or links', () => {
  const blocked = renderLiveSummary({ summaryMode: 'responses-core', live: false, results: [] });
  assert.match(blocked, /Not run: setup failed/);
  assert.doesNotMatch(blocked, /Passed|\u{1f7e2}/u);
  const summary = renderLiveSummary({
    summaryMode: 'responses-core', links: { source: 'javascript:alert(1)', logs: 'https://github.com/x/y/actions/runs/1)bad' },
    results: [{ feature: 'method:create', provider: 'openai', status: 'blocked-before-paid-calls' }],
  });
  assert.match(summary, /Not run: preflight blocked/);
  assert.doesNotMatch(summary, /javascript:|bad|\]\(/);
});

function offlineReport() {
  const entry = (version, parsed, delivery) => ({
    version,
    responses: {
      featureCount: version === '7.3.0' ? 100 : 102,
      missingContracts: [], unreviewedSchemas: [], unreviewedRemovals: [],
      errorDelivery: delivery, rawJsonSchemaStreamParsing: parsed,
    },
    azureNativeTypeGaps: [
      { type: 'ChatCompletionCreateParamsNonStreaming', field: 'data_sources', withAzureTypes: true },
      { type: 'ChatCompletionMessage', field: 'context', withAzureTypes: true },
    ],
    legacyEnhancements: { nativeTyped: false, companionTyped: false },
  });
  return {
    packages: [entry('7.3.0', 'not-parsed', 'event'), entry('7.45.1', 'json-parsed', 'exception')],
    references: { azureCompanionVersion: '2.0.0', legacyAzureVersion: '1.0.0-beta.13' },
    responsesAddedByAzureCompanion: [],
    responsesVersionDifferences: { added: ['tool-field:function.async'], removed: ['event-field:response.function_call_arguments.done.name'] },
  };
}

function liveReport() {
  return {
    live: true, blockedBeforePaidCalls: false, responses: { mode: 'selected', complete: false },
    results: ['baseline', 'current'].flatMap((label) => ['azure-v1', 'openai'].flatMap((route) =>
      ['create', 'parse', 'stream'].map((method) => ({
        client: `${label}-${route}`, provider: route === 'openai' ? 'openai' : 'azure',
        version: label === 'baseline' ? '7.3.0' : '7.45.1', feature: `method:${method}`, status: 'passed',
      })))),
  };
}

test('offline summary explains the comparison, gap impact, remedy, and limits without treating additions as failures', () => {
  const summary = renderResponsesSummary(offlineReport());
  assert.match(summary, /Offline coverage checks passed/);
  assert.match(summary, /type companion, not a separate runtime client/);
  assert.match(summary, /Azure Search grounding in chat requests/);
  assert.match(summary, /Chat\/completion, image, and upload fields are distinct from the Responses API/);
  assert.match(summary, /Resolved by import "@azure\/openai\/types"/);
  assert.match(summary, /Legacy `enhancements` request option/);
  assert.match(summary, /Yields an error event/);
  assert.match(summary, /Throws an SDK exception/);
  assert.match(summary, /Leaves output_parsed null/);
  assert.match(summary, /different from the explicit responses\.parse\(\)/);
  assert.match(summary, /counts are not separate endpoints or failed tests/);
  assert.match(summary, /event-field:response\.function_call_arguments\.done\.name/);
  assert.match(summary, /Zero review gaps means offline contract coverage is reviewed, not that every feature passed against live APIs/);
  const detail = summary.indexOf('<summary>Added Responses');
  assert.ok(detail > summary.indexOf('### What did the live APIs prove?'));
  assert.ok(summary.indexOf('tool-field:function.async') > detail);
});

test('unreviewed declarations and companion-unresolved fields change the offline verdict and action', () => {
  const report = offlineReport();
  report.packages[1].responses.unreviewedSchemas.push('responses.FutureOptions');
  report.packages[0].azureNativeTypeGaps[0].withAzureTypes = false;
  const summary = renderResponsesSummary(report);
  assert.match(summary, /Action required/);
  assert.match(summary, /Some actual client call sites remain untyped/);
  assert.match(summary, /2 native declaration typing gaps; 1 declarations remain unresolved/);
  assert.match(summary, /Changed declaration: `responses.FutureOptions`/);
  assert.doesNotMatch(summary, /Offline coverage checks passed/);
});

test('offline summary distinguishes patched root exports from unresolved method-result typing', () => {
  const report = offlineReport();
  report.packages[0].azureNativeTypeGaps.push({
    type: 'UploadPart', field: 'azure_block_id', withAzureTypes: true, callSite: { native: false, withAzureTypes: false, reviewedGap: true },
  });
  const summary = renderResponsesSummary(report);
  assert.match(summary, /1 actual client-call typing gap remains/);
  assert.match(summary, /root-export augmentation does not necessarily reach the method return type/);
  assert.match(summary, /UploadPart.azure_block_id` \| Yes \| No/);
  assert.doesNotMatch(summary, /3 native declaration typing gaps; 1 declarations remain unresolved/);
  assert.match(summary, /Offline coverage checks passed/);
  report.packages[0].azureNativeTypeGaps[2].callSite.reviewedGap = false;
  assert.match(renderResponsesSummary(report), /Action required/);
});

test('live summary explains all twelve passes as partial coverage and identifies the actual SDK/provider comparison', () => {
  const summary = renderLiveSummary(liveReport());
  assert.match(summary, /All 12 selected live cases passed/);
  assert.match(summary, /complete: false means partial coverage, not a failed test/);
  for (const target of ['Azure OpenAI v1 / baseline SDK 7.3.0', 'OpenAI-hosted API / comparison SDK 7.45.1']) assert.ok(summary.includes(target));
  assert.match(summary, /service at api\.openai\.com using your OpenAI key/);
  assert.match(summary, /Create a text response/);
  assert.match(summary, /Valid JSON equals \{"value":7\}/);
  assert.match(summary, /not separate @azure\/openai and OpenAI runtime implementations/);
  assert.match(summary, /legacy @azure\/openai client has no Responses resource/);
  assert.match(summary, /does not compare answer quality, latency, or cost/);
  assert.match(summary, /3 of 9 core methods passed/);
  for (const method of ['retrieve', 'delete', 'cancel', 'compact', 'inputItems.list', 'inputTokens.count']) {
    assert.ok(summary.includes(`responses.${method}()`));
  }
  assert.match(summary, /Not selected; no live evidence in this run/);
  assert.match(summary, /test-coverage gaps, not demonstrated SDK defects/);
});

test('blocked, unsupported, absent SDK, and failed outcomes are never summarized as live passes', () => {
  const report = liveReport();
  report.live = false;
  report.blockedBeforePaidCalls = true;
  report.responses = { mode: 'full', complete: false };
  report.results = [
    { provider: 'azure', feature: 'tool:mcp', status: 'missing-fixture' },
    { provider: 'openai', feature: 'tool:mcp', status: 'blocked-before-paid-calls' },
  ];
  let summary = renderLiveSummary(report);
  assert.match(summary, /fixture preflight blocked all paid API calls/);
  assert.match(summary, /No paid API calls: blocked before execution/);
  assert.match(summary, /Not run: missing fixture/);
  assert.match(summary, /Full inventory requested, but coverage is incomplete/);
  assert.doesNotMatch(summary, /All \d+ selected live cases passed/);

  report.blockedBeforePaidCalls = false;
  report.live = true;
  report.results = [
    { provider: 'azure', client: 'baseline-azure-versioned', version: '7.3.0', feature: 'method:create', status: 'failed',
      error: { status: 403, message: 'SECRET-ERROR-CONTENT', code: 'SECRET-CODE' } },
    { provider: 'openai', client: 'current-openai', version: '7.45.1', feature: 'method:create', status: 'declared-unsupported', reason: 'SECRET-CONFIG' },
    { provider: 'azure', client: 'current-azure-v1', version: '7.45.1', feature: 'method:parse', status: 'sdk-unavailable' },
  ];
  summary = renderLiveSummary(report);
  assert.match(summary, /0 passed, 1 failed, and 2 were not passed or not run/);
  assert.match(summary, /Failed \(HTTP 403\)/);
  assert.match(summary, /Declared unsupported \(not verified\)/);
  assert.match(summary, /Unavailable in SDK/);
  assert.match(summary, /Not run/);
  assert.match(summary, /service rejections, not automatically SDK defects/);
  assert.doesNotMatch(summary, /SECRET/);
});

test('empty runs and unselected Responses cannot be presented as complete Responses coverage', () => {
  assert.match(renderLiveSummary({ live: false, results: [] }), /No live case results were recorded/);
  const summary = renderLiveSummary({ live: true, results: [{
    suite: 'chat', client: 'legacy-azure', provider: 'azure', status: 'passed',
  }] });
  assert.match(summary, /Responses suite was not selected/);
  assert.match(summary, /Azure OpenAI \/ legacy @azure\/openai/);
  assert.doesNotMatch(summary, /legacy.*SDK version not recorded/);
});

test('HTTP failures explain observed steps and suspected causes in the main comparison table, not just expandable details', () => {
  const report = { live: true, results: [
    { suite: 'responses', provider: 'azure', client: 'baseline-azure-v1', version: '7.3.0',
      feature: 'method:inputTokens.count', status: 'failed',
      error: { status: 400, operation: 'responses.inputTokens.count', serviceSignals: ['unsupported', 'model'] } },
    { suite: 'responses', provider: 'azure', client: 'current-azure-v1', version: '7.45.1',
      feature: 'method:inputItems.list', status: 'failed',
      error: { status: 404, operation: 'responses.inputItems.list', serviceSignals: ['not-found'] } },
    { suite: 'responses', provider: 'openai', client: 'current-openai', version: '7.45.1',
      feature: 'method:inputTokens.count', status: 'passed' },
  ] };
  const summary = renderLiveSummary(report);
  const tokenRow = summary.split('\n').find((line) => line.startsWith('| Count input tokens |') && line.includes('HTTP 400'));
  const itemsRow = summary.split('\n').find((line) => line.startsWith('| List stored input items across pages |') && line.includes('HTTP 404'));
  assert.match(tokenRow, /Failed \(HTTP 400\)<br>Failed step: Count input tokens/);
  assert.match(tokenRow, /Suspected Azure model\/service support limitation \(unconfirmed/);
  assert.match(tokenRow, /\| Passed \|$/);
  assert.match(itemsRow, /Failed \(HTTP 404\)<br>Failed step: Fetch first input-items page/);
  assert.match(itemsRow, /Root cause unconfirmed; stored-response visibility\/routing/);
  assert.doesNotMatch(itemsRow, /API is unsupported|SDK regression|cursor availability/);
});

test('inline failure explanations prefer explicit service evidence and safely handle absent or unrecognized diagnostics', () => {
  const rows = [
    { status: 400, serviceCode: 'DeploymentNotFound', serviceSignals: ['unsupported', 'model'] },
    { status: 400, serviceCode: 'OperationNotSupported' },
    { status: 404, serviceSignals: ['unknown-request-url'] },
    { status: 404, operation: 'responses.inputItems.list.nextPage', serviceSignals: ['not-found'] },
    { status: 400, serviceCode: 'SECRET-CODE', operation: 'SECRET-OPERATION', serviceSignals: ['SECRET-SIGNAL', 'constructor'] },
    { status: 404, operation: 'responses.inputItems.list', serviceSignals: 'SECRET-SIGNALS' },
    { status: 400, serviceCode: 'constructor', operation: 'constructor' },
    { status: 403 },
  ].map((error) => ({ suite: 'responses', provider: 'azure', client: 'baseline-azure-v1', version: '7.3.0',
    feature: 'method:inputItems.list', status: 'failed', error: { ...error, message: 'SECRET-RAW-MESSAGE', rootCause: 'SECRET-CAUSE' } }));
  const summary = renderLiveSummary({ live: true, results: rows });
  const mainRow = summary.split('\n').find((line) => line.startsWith('| List stored input items across pages |') && line.includes('HTTP 400'));
  assert.match(mainRow, /Service reports that the Azure deployment was not found/);
  assert.match(mainRow, /Service reports that this operation is not supported/);
  assert.match(mainRow, /Service did not recognize the request URL/);
  assert.match(mainRow, /Failed step: Fetch next input-items page/);
  assert.match(mainRow, /Root cause not captured; further investigation required/);
  assert.doesNotMatch(summary, /SECRET-|function Object|function constructor/);
});

test('failed results are attributed to the OpenAI SDK, Azure OpenAI API, or OpenAI API spec by comparing SDKs and providers', () => {
  const row = (client, status, error) => ({ suite: 'responses', feature: 'method:create', client, status, error,
    provider: client.includes('azure') ? 'azure' : 'openai', version: client.startsWith('baseline') ? '7.3.0' : '7.45.1' });
  const category = (rows) => responsesFailureCategory(rows[0], rows);
  const http400 = { status: 400 };
  assert.equal(category([row('baseline-azure-v1', 'failed', http400), row('current-azure-v1', 'passed'), row('baseline-openai', 'passed')]),
    'OpenAI SDK issue: fails on SDK 7.3.0 but passes on SDK 7.45.1 against the same API');
  assert.equal(category([row('current-azure-v1', 'failed', http400), row('baseline-azure-v1', 'failed', http400),
    row('current-openai', 'passed'), row('baseline-openai', 'passed')]),
  'Azure OpenAI API issue: fails on Azure OpenAI but passes on OpenAI-hosted API with the same SDK');
  assert.equal(category([row('current-openai', 'failed', http400), row('baseline-openai', 'failed', http400),
    row('current-azure-v1', 'passed')]), 'OpenAI API Spec issue: fails on OpenAI-hosted API but passes on Azure OpenAI with the same SDK');
  const assertion = { name: 'AssertionError', status: null };
  assert.match(category(['current-azure-v1', 'baseline-azure-v1', 'current-openai', 'baseline-openai']
    .map((client) => row(client, 'failed', assertion))), /^OpenAI API Spec issue: fails on every compared API and SDK version/);
  assert.equal(category([row('baseline-azure-v1', 'failed', { status: 400, knownCause: 'model-unsupported-for-operation' })]),
    'Azure OpenAI API issue: model not supported for this operation');
  assert.equal(category([row('baseline-azure-v1', 'failed', { status: 403 }), row('baseline-openai', 'passed')]),
    'Configuration issue: credentials or permissions rejected (HTTP 403)');
  assert.equal(category([row('baseline-azure-v1', 'failed', http400)]), 'API rejection; cause unconfirmed');
  const summary = renderLiveSummary({ live: true, summaryMode: 'responses-core', results: [
    row('baseline-azure-v1', 'failed', http400), row('baseline-openai', 'passed')] });
  assert.match(summary, /Failed \(HTTP 400\); Azure OpenAI API issue: fails on Azure OpenAI but passes on OpenAI-hosted API/);
  assert.match(renderResponsesCaseLog(row('baseline-azure-v1', 'failed', http400), [row('baseline-openai', 'passed')]),
    /Category: Azure OpenAI API issue/);
});

test('categorized failures file one issue per fingerprint, reuse existing issues, and link the category text', async () => {
  const { fileFailureIssues } = await import('../scripts/failure-issues.mjs');
  const base = { suite: 'responses', feature: 'method:inputTokens.count', version: '7.3.0' };
  const fail = (client, requestId) => ({ ...base, client, provider: 'azure', status: 'failed', version: client.startsWith('baseline') ? '7.3.0' : '7.45.1',
    error: { status: 400, operation: 'responses.inputTokens.count', knownCause: 'model-unsupported-for-operation', requestId,
      serviceMessage: 'This model is not supported by Responses API.' } });
  const report = { summaryMode: 'responses-core', links: { run: 'https://github.com/o/r/actions/runs/1', cases: {} }, results: [
    fail('baseline-azure-v1', 'req-aaaaaaaa'), fail('current-azure-v1', 'req-bbbbbbbb'),
    { ...base, client: 'baseline-openai', provider: 'openai', status: 'passed' },
    { ...base, client: 'baseline-openai', provider: 'openai', feature: 'method:create', status: 'failed', error: { status: 401 } },
  ] };
  const calls = [];
  let issues = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('https://api.github.com/', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (path.endsWith('/labels')) return reply(422, {});
    if (init.method === 'GET' && path.includes('/issues?')) return reply(200, issues);
    if (init.method === 'GET' && path.includes('/comments')) return reply(200, []);
    if (init.method === 'POST' && path.endsWith('/issues')) {
      const created = { number: 7, state: 'open', body: body.body, html_url: 'https://github.com/KarishmaGhiya/azure-rest-api-specs/issues/7' };
      issues = [created];
      return reply(201, created);
    }
    return reply(201, {});
  };
  const links = await fileFailureIssues({ report, token: 't', fetchImpl, log: () => {} });
  const created = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/issues'));
  assert.equal(created.length, 1, 'both Azure SDK failures share one issue; the 401 is not filed');
  assert.equal(created[0].path, 'repos/KarishmaGhiya/azure-rest-api-specs/issues');
  assert.match(created[0].body.title, /Count input tokens on Azure OpenAI: model not supported/);
  assert.match(created[0].body.body, /Request ID: req-aaaaaaaa[\s\S]*Request ID: req-bbbbbbbb/);
  assert.match(created[0].body.body, /OpenAI-hosted API \/ baseline SDK 7\.3\.0 \| Passed/);
  assert.deepEqual(Object.values(links), Array(2).fill('https://github.com/KarishmaGhiya/azure-rest-api-specs/issues/7'));

  calls.length = 0;
  await fileFailureIssues({ report, token: 't', fetchImpl, log: () => {} });
  assert.equal(calls.filter((call) => call.method !== 'GET').length, 1, 'same evidence: reuse without a comment (only the label probe)');

  calls.length = 0;
  report.results[1].error.serviceMessage = 'Token counting is unavailable for this deployment.';
  await fileFailureIssues({ report, token: 't', fetchImpl, log: () => {} });
  const comments = calls.filter((call) => call.path.endsWith('/issues/7/comments') && call.method === 'POST');
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /New evidence[\s\S]*comparison SDK 7\.45\.1/);
  assert.doesNotMatch(comments[0].body.body, /baseline SDK 7\.3\.0/);

  const summary = renderLiveSummary({ ...report, links: { ...report.links, issues: links } });
  assert.match(summary, /🔴 Failed \(HTTP 400\); \[Azure OpenAI API issue: model not supported for this operation\]\(https:\/\/github\.com\/KarishmaGhiya\/azure-rest-api-specs\/issues\/7\)/);
});

test('the issue-filing GitHub App key is exchanged for a token limited to the issue repositories and Issues: write', async () => {
  const { appInstallationToken } = await import('../scripts/failure-issues.mjs');
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => (url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_x' }) };
  };
  const token = await appInstallationToken({ clientId: 'Iv1.abc', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    repos: { openapi: 'o/spec', sdk: 'o/node', azure: 'o/azure' }, fetchImpl, now: 1_000_000_000 });
  assert.equal(token, 'ghs_x');
  const jwt = calls[0].init.headers.authorization.replace('Bearer ', '');
  const [header, payload, signature] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: 999_940, exp: 1_000_480, iss: 'Iv1.abc' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/spec/installation');
  assert.equal(calls[1].url, 'https://api.github.com/app/installations/42/access_tokens');
  assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ['spec', 'node', 'azure'], permissions: { issues: 'write' } });
  await assert.rejects(appInstallationToken({ clientId: 'x', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    repos: { openapi: 'a/x', sdk: 'b/y', azure: 'a/z' }, fetchImpl }), /share one owner/);
});
