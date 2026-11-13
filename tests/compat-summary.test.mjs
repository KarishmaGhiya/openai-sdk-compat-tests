import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLiveSummary, renderResponsesSummary } from '../lib/compat-summary.mjs';

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
