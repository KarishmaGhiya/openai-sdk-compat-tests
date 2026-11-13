const cell = (value) => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const table = (headers, rows) => [
  '',
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
];
const details = (title, lines) => ['', '<details>', `<summary>${title}</summary>`, '', ...lines, '', '</details>', ''];
const reviewCount = (entry) => entry.responses.missingContracts.length +
  entry.responses.unreviewedSchemas.length + entry.responses.unreviewedRemovals.length;

function azureGapCategory(field) {
  if (field.field === 'data_sources') return 'Azure Search grounding in chat requests';
  if (field.field === 'context') return 'Chat grounding context and citations';
  if (field.field.includes('filter_results')) return 'Azure content-filter metadata';
  if (field.field === 'azure_block_id') return 'Azure upload block metadata';
  return 'Other Azure-specific fields';
}

export function renderResponsesSummary(report) {
  const { packages, responsesVersionDifferences: differences } = report;
  const needsReview = packages.reduce((sum, entry) => sum + reviewCount(entry), 0);
  const unresolved = packages.flatMap((entry) => entry.azureNativeTypeGaps.filter((field) => !field.withAzureTypes));
  const lines = [
    '## SDK compatibility findings - offline checks',
    '',
    needsReview || unresolved.length
      ? '**Action required: unreviewed SDK changes or unresolved Azure typing gaps were found. See the review counts below.**'
      : '**Offline coverage checks passed. Known typing and SDK behavior differences are explained below; this is not a claim of full live compatibility.**',
    '',
    '### What was compared?',
    ...table(['Component', 'Comparison and purpose'], [
      ['OpenAI JavaScript/TypeScript SDK', packages.map((entry) => entry.version).join(' vs ')],
      ['Azure type companion', `@azure/openai ${report.references.azureCompanionVersion}; checks which Azure-only types it adds to the OpenAI SDK`],
      ['Legacy Azure SDK', `@azure/openai ${report.references.legacyAzureVersion}; migration reference only, with no Responses API equivalent`],
      ['Evidence', 'TypeScript compilation, declaration inventory, and real SDK clients with injected HTTP transports; no live API requests in this section'],
      ['Responses routes checked by the offline suite', 'OpenAI-hosted API, Azure versioned API, and Azure v1 API'],
    ]),
    '',
    '**Not two independent Responses SDKs:** the stable Azure package is a type companion, not a separate runtime client. Responses runtime tests use the OpenAI Node SDK against different provider endpoints. The separate legacy Azure client is relevant to migration checks, not Responses parity.',
    '',
    '### Which Azure capabilities need extra types?',
    'These are TypeScript typing gaps in the native OpenAI SDK, not evidence that JSON data is dropped or that Azure rejects a request.',
    'Chat/completion, image, and upload fields are distinct from the Responses API. The exact API types are listed in the expandable field details.',
  ];
  const categories = new Map();
  for (const entry of packages) {
    for (const field of entry.azureNativeTypeGaps) {
      const name = azureGapCategory(field);
      if (!categories.has(name)) categories.set(name, { fields: new Set(), versions: new Set(), unresolved: false });
      const group = categories.get(name);
      group.fields.add(`${field.type}.${field.field}`);
      group.versions.add(entry.version);
      group.unresolved ||= !field.withAzureTypes;
    }
  }
  if (categories.size) lines.push(...table(['Azure capability', 'Affected SDK versions', 'Impact and action'], [...categories].map(([name, group]) => [
    `${name} (${group.fields.size} distinct typed ${group.fields.size === 1 ? 'field' : 'fields'})`, [...group.versions].join(', '),
    group.unresolved ? 'Some fields remain untyped even with the Azure companion; review the field details.'
      : 'Resolved by import "@azure/openai/types"; adapt TypeScript imports, not the service endpoint.',
  ])));
  else lines.push('No native Azure type-extension gaps were found in the measured fields.');
  for (const entry of packages) {
    lines.push('', `SDK ${entry.version}: **${entry.azureNativeTypeGaps.length} native typing gaps; ${entry.azureNativeTypeGaps.filter((field) => !field.withAzureTypes).length} remain unresolved by the companion.**`);
  }
  const enhancements = packages.filter((entry) => !entry.legacyEnhancements.nativeTyped);
  if (enhancements.length) {
    const unresolvedEnhancements = enhancements.filter((entry) => !entry.legacyEnhancements.companionTyped);
    lines.push('', `**Legacy \`enhancements\` request option:** not natively typed in ${enhancements.map((entry) => entry.version).join(', ')}.` +
      (unresolvedEnhancements.length ? ` The stable Azure companion also does not type it in ${unresolvedEnhancements.map((entry) => entry.version).join(', ')}.` : ' The Azure companion supplies its type.') +
      ' Offline tests preserve its JSON, but current Azure service support is unverified. Confirm API/model support before relying on it.');
  }
  lines.push(
    '',
    '### What changes when upgrading the OpenAI SDK?',
    'The following are differences between SDK versions, not features proved to exist only in the Azure SDK.',
    ...table(['Behavior', ...packages.map((entry) => `SDK ${entry.version}`), 'Impact on application code'], [
      ['An SSE error arrives during raw Responses streaming',
        ...packages.map((entry) => entry.responses.errorDelivery === 'event' ? 'Yields an error event' : entry.responses.errorDelivery === 'exception' ? 'Throws an SDK exception' : 'Not classified'),
        'Use the error-handling behavior appropriate to your SDK; do not assume every stream error is yielded as an event.'],
      ['Streaming helper with a raw JSON Schema format',
        ...packages.map((entry) => entry.responses.rawJsonSchemaStreamParsing === 'json-parsed' ? 'Parses the final JSON into output_parsed'
          : entry.responses.rawJsonSchemaStreamParsing === 'not-parsed' ? 'Leaves output_parsed null' : 'Not classified'),
        'Check this before using output_parsed from responses.stream(). This is different from the explicit responses.parse() method.'],
    ]),
    '',
    `The comparison SDK adds **${differences.added.length} inventoried features/fields** and removes **${differences.removed.length}** relative to the baseline. These counts are not separate endpoints or failed tests.`,
    'Examples include request controls, tool/input/output fields, and streaming event fields. An added declaration does not establish support in your Azure region, model, or API version.',
  );
  if (differences.removed.length) lines.push(
    ...table(['Removed baseline feature or field', 'What to review'], differences.removed.map((id) => [
      `\`${id}\``, 'Code or TypeScript types that depend on this field. This is a declared SDK surface removal, not proof that a service stopped returning JSON.',
    ])),
  );
  lines.push(
    '',
    `**Azure companion Responses additions: ${report.responsesAddedByAzureCompanion.length}.** This counts Responses-specific type additions in the pinned companion, not Azure service support. The legacy Azure client has no Responses resource and is not a passing Responses comparison target.`,
    '',
    '### How much was checked offline?',
    ...table(['SDK version', 'Inventoried Responses feature/field cases', 'New cases needing review', 'Changed declarations needing review', 'Unreviewed baseline removals'],
      packages.map((entry) => [
        entry.version, entry.responses.featureCount, entry.responses.missingContracts.length,
        entry.responses.unreviewedSchemas.length, entry.responses.unreviewedRemovals.length,
      ])),
    '',
    '**Zero review gaps means offline contract coverage is reviewed, not that every feature passed against live APIs.** It does not cover every parameter combination or prove equivalent generated answers.',
    '',
    '### What did the live APIs prove?',
    'Nothing is inferred from this offline section. In a live workflow, read the separate **Live API results** section and the **azure-live-results** artifact (`azure-live.json`). In offline-only CI, no paid calls are made.',
    'Full live Responses coverage still requires provider/model-specific fixtures. Selected runs remain partial even when every selected case passes.',
    '',
    '### Where are the exact details?',
    'The machine-readable offline report is `reports/responses-compatibility.json`. CI uploads it in `coverage-inventory-<os>`; the live workflow uploads it separately in `sdk-compatibility-details`.',
    ...details('Exact Azure type gaps and companion coverage', table(
      ['SDK', 'Native typing gap', 'Resolved by Azure companion?'],
      packages.flatMap((entry) => entry.azureNativeTypeGaps.map((field) => [
        entry.version, `\`${field.type}.${field.field}\``, field.withAzureTypes ? 'Yes' : 'No',
      ])),
    )),
    ...details('Added Responses feature/field IDs (technical inventory, not live results)',
      differences.added.length ? differences.added.map((id) => `- \`${cell(id)}\``) : ['No additions.']),
  );
  if (needsReview) lines.push(...details('Offline changes requiring test review', packages.flatMap((entry) => [
    `**SDK ${entry.version}**`,
    ...entry.responses.missingContracts.map((id) => `- New case: \`${cell(id)}\``),
    ...entry.responses.unreviewedSchemas.map((id) => `- Changed declaration: \`${cell(id)}\``),
    ...entry.responses.unreviewedRemovals.map((id) => `- Unreviewed removal: \`${cell(id)}\``),
  ])));
  return `${lines.join('\n')}\n`;
}

const featureNames = {
  'method:create': 'Create a text response',
  'method:parse': 'Parse structured JSON',
  'method:stream': 'Stream text to completion',
  'method:retrieve': 'Retrieve a stored response',
  'method:delete': 'Delete a stored response',
  'method:cancel': 'Cancel a background response',
  'method:compact': 'Compact conversation state',
  'method:inputItems.list': 'List stored input items across pages',
  'method:inputTokens.count': 'Count input tokens',
  'tool:function': 'Function-call arguments and result round trip',
  'create:previous_response_id': 'Reuse previous-response conversation state',
  'format:text': 'Return text format',
  'format:json_object': 'Return a JSON object',
  'format:json_schema': 'Return JSON matching a schema',
};
const statuses = {
  passed: 'Passed', failed: 'Failed',
  'sdk-unavailable': 'Unavailable in SDK',
  'declared-unsupported': 'Declared unsupported (not verified)',
  'missing-fixture': 'Not run: missing fixture',
  'invalid-fixture': 'Not run: invalid fixture',
  'blocked-before-paid-calls': 'Not run: preflight blocked',
};
function targetName(row) {
  const version = /^\d+\.\d+\.\d+$/.test(row.version ?? '') ? row.version : 'version not recorded';
  const provider = row.provider === 'azure' ? 'Azure OpenAI' : row.provider === 'openai' ? 'OpenAI-hosted API' : 'Unidentified provider';
  const route = row.client?.endsWith('-azure-v1') ? ' v1' : row.client?.endsWith('-azure-versioned') ? ' versioned' : '';
  if (!row.client) return `${provider} (preflight)`;
  if (row.client.endsWith('-dimension-parity')) return `${provider} / embedding dimension comparison`;
  if (row.client === 'legacy-azure') return `${provider} / legacy @azure/openai`;
  const comparison = row.client.startsWith('baseline-') ? 'baseline' : row.client.startsWith('current-') ? 'comparison' : 'other';
  return `${provider}${route} / ${comparison} SDK ${version}`;
}
function caseName(row) {
  if (featureNames[row.feature]) return featureNames[row.feature];
  if (row.feature) {
    const [kind, ...parts] = row.feature.split(':');
    const names = {
      create: 'Request option', retrieve: 'Retrieve option', compact: 'Compaction option',
      'input-items': 'Input-item listing option', 'input-tokens': 'Token-count option',
      control: 'Request control', response: 'Response field', status: 'Response status',
      tool: 'Tool', 'tool-field': 'Tool field', input: 'Input item', 'input-field': 'Input-item field',
      output: 'Output item', 'output-field': 'Output-item field', event: 'Stream event', 'event-field': 'Stream-event field',
      content: 'Input content', 'content-field': 'Input-content field',
      'output-content': 'Output content', 'output-content-field': 'Output-content field',
      format: 'Output format', 'format-field': 'Output-format field', include: 'Included response data', 'tool-choice': 'Tool selection',
    };
    return `${names[kind] ?? 'Configured feature'}: ${parts.join(':').replaceAll('_', ' ')}`;
  }
  const suites = {
    chat: 'Chat completion', 'chat-stream': 'Stream chat text', embeddings: 'Create embeddings',
    completions: 'Text completion', 'completions-stream': 'Stream completion text', images: 'Generate an image',
    transcription: 'Transcribe audio', translation: 'Translate audio', 'on-your-data': 'Azure Search grounding and citations',
    'azure-filters': 'Azure content-filter metadata',
  };
  return suites[row.suite] ?? 'Other selected suite';
}
function outcome(row) {
  const status = statuses[row.status] ?? 'Not passed';
  const http = row.error?.status;
  return `${status}${Number.isInteger(http) && http >= 100 && http <= 599 ? ` (HTTP ${http})` : ''}`;
}

export function renderLiveSummary(report) {
  const rows = report.results.map((row) => ({
    ...row, version: row.version ?? report.versions?.[row.client?.startsWith('baseline-') ? 'openai'
      : row.client?.startsWith('current-') ? 'openai-current' : 'azure-openai-legacy'],
  }));
  const passed = rows.filter((row) => row.status === 'passed').length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  const notPassed = rows.length - passed - failed;
  const blocked = report.blockedBeforePaidCalls === true;
  const verdict = blocked ? 'Not run: fixture preflight blocked all paid API calls.'
    : rows.length === 0 ? 'No live case results were recorded; no compatibility conclusion can be drawn.'
      : passed === rows.length ? `All ${passed} selected live cases passed. No failure was observed in the tested combinations.`
        : `${passed} passed, ${failed} failed, and ${notPassed} were not passed or not run. Compatibility is not established for all selected cases.`;
  const lines = [
    '## Live API results',
    '',
    `**${verdict}**`,
    '',
    ...table(['Evidence', 'What this run establishes'], [
      ['Execution', blocked ? 'No paid API calls: blocked before execution' : report.live ? 'Live execution enabled; per-case outcomes below show what passed' : 'Live execution not confirmed'],
      ['Passed / failed / other outcomes', `${passed} / ${failed} / ${notPassed}`],
      ['Responses coverage', report.responses
        ? report.responses.mode === 'selected' ? 'Selected features only. complete: false means partial coverage, not a failed test.'
          : report.responses.complete ? 'Full configured feature inventory passed; not every parameter/model combination.'
            : 'Full inventory requested, but coverage is incomplete. See nonpassing outcomes.'
        : 'Responses suite was not selected.'],
      ['Meaning of a pass', 'The selected request completed and its assertions passed on that SDK/provider combination; identical model answers are not required.'],
    ]),
    '',
    '### What was compared against live APIs?',
    'These are OpenAI Node SDK versions running against different providers, not separate @azure/openai and OpenAI runtime implementations.',
    '**OpenAI-hosted API** means the service at api.openai.com using your OpenAI key. **Azure OpenAI** means your Azure resource using Azure authentication. The report does not publish your private endpoint or model configuration.',
  ];
  const targets = [...new Set(rows.map(targetName))];
  const cases = [...new Set(rows.map((row) => row.feature ?? row.suite))];
  if (rows.length) lines.push(...table(['Test', ...targets], cases.map((id) => {
    const matching = rows.filter((row) => (row.feature ?? row.suite) === id);
    return [caseName(matching[0]), ...targets.map((target) => {
      const entries = matching.filter((row) => targetName(row) === target);
      return entries.length ? [...new Set(entries.map(outcome))].join('; ') : 'Not run';
    })];
  })));
  if (rows.some((row) => row.feature && featureNames[row.feature])) lines.push(
    ...details('What the selected Responses tests assert', [
      ...cases.filter((id) => featureNames[id]).map((id) => {
        const assertions = {
          'method:create': 'Completed status, nonempty output text, and positive token usage.',
          'method:parse': 'Valid JSON equals {"value":7}, including the SDK-parsed output.',
          'method:stream': 'Text deltas are received, final status is completed, and final output text is nonempty.',
        };
        return `- **${featureNames[id]}:** ${assertions[id] ?? 'Runs the authored feature assertions; stored resources have cleanup where required.'}`;
      }),
      '',
      'The descriptions refer to builtin tests; private scenarios may supply their own assertions.',
    ]),
  );
  if (rows.some((row) => row.status !== 'passed')) lines.push(
    '',
    '### How to interpret nonpassing outcomes',
    'Failed HTTP requests are service rejections, not automatically SDK defects: check credentials, model, API version, and permissions. A failed assertion may require SDK or test investigation.',
    'Missing/invalid fixtures mean the feature was not exercised. Declared unsupported means configuration says it is unsupported, not that a live test proved it. Unavailable in SDK is a surface gap for that SDK version.',
    'Resolve the listed failures or fixture requirements before claiming compatibility; do not count these outcomes as passes.',
  );
  lines.push(
    '',
    '### What this does not prove',
    'This run does not establish compatibility for unselected features, other SDK versions/models, or every parameter combination. It does not compare answer quality, latency, or cost.',
    rows.some((row) => row.feature)
      ? 'The legacy @azure/openai client has no Responses resource and is not a Responses target, even though its installed version appears in the JSON report.'
      : 'Azure-only capabilities are not evidence that the OpenAI-hosted service supports those capabilities.',
    'Offline Azure typing gaps and SDK behavior differences are reported separately above; live passes do not erase those differences.',
    '',
    '**Result artifact:** `azure-live-results` contains `azure-live.json` with SDK versions and redacted per-case outcomes. It excludes API keys, endpoint/model configuration values, prompts, and generated content.',
  );
  return `${lines.join('\n')}\n`;
}
