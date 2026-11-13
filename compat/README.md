# Azure OpenAI versus OpenAI SDK compatibility

This suite compares **JavaScript/TypeScript** packages, not Azure service
features against OpenAI service features. Azure-specific features are sent only
to Azure. It does not claim that the public OpenAI API implements Azure Search
grounding, content-filter metadata, Azure deployment routing, or Azure RBAC.

## Pinned comparisons

| Package | Version | Purpose |
|---|---|---|
| `azure-openai-legacy` (alias of `@azure/openai`) | `1.0.0-beta.13` | Retired standalone `OpenAIClient`, used only as a migration reference |
| `@azure/openai` | `2.0.0` | Stable Azure-specific TypeScript augmentations |
| `openai` | `7.3.0` | Existing suite baseline |
| `openai-current` (alias of `openai`) | `7.45.1` | Additional pinned comparison, not a moving `latest` dependency |

The current Azure companion is not a second runtime client: it adds types to
the `AzureOpenAI` client exported by `openai`. The two Azure versions are
installed side by side deliberately. Azure's separate AssistantsClient package,
preview Azure SDK releases, and all possible Azure model/API-version combinations
are outside this comparison.

## Run offline

```powershell
npm ci --ignore-scripts
npm run test:azure
npm run azure:report
```

These tests never need credentials or contact inference services. The tests
instantiate actual SDK clients and intercept their HTTP transports. They cover
all eight public legacy operations, API-key and Entra headers, deployment and
API-version routing, sampling/tools/functions options, On Your Data request
serialization, content-filter/citation response preservation, streamed chat/text,
images, embeddings, and multipart audio.

Separate TypeScript compiler programs measure **all 13 fields** added by the
stable Azure companion before and after `import "@azure/openai/types"`. Each
OpenAI version is resolved as the canonical `openai` package in isolation,
including the ESM declaration files; otherwise an alias or mixed CJS/ESM
declaration graph can produce misleading augmentation results. Declaration
library checking is skipped; actual property and API call-site type checks are
not skipped. This is not a full build/type audit of the dependencies.

`npm run azure:report` writes `reports/azure-compatibility.json` and a GitHub job
summary. Regular CI runs the tests and uploads that report on Linux and Windows.
New unresolved companion fields fail the tests/report rather than disappearing
from coverage.

## Verified differences

For these pinned versions:

| Difference | Result | Interpretation |
|---|---|---|
| Azure `data_sources`, prompt/choice filter results, citation context, image filter results, and `azure_block_id` | 13 root declaration fields absent natively; all 13 declarations patched, but only 12 actual client call sites type-check with the companion | Declaration coverage is not the same as usable client-call typing |
| `uploads.parts.create().azure_block_id` | The method result remains untyped with the companion, despite the augmented root `UploadPart` export | Actual call-site typing gap in both pinned SDKs; runtime preservation must be checked separately |
| Legacy `azureExtensionOptions.enhancements` | Neither OpenAI version nor the stable companion types the migrated `enhancements` request property | Verified request-type gap; JSON pass-through works, but current service support is not established |
| `getChatCompletions`, `getEmbeddings`, etc. | All eight have transport-tested modern equivalents | Source migration required; no missing endpoint found within these eight |
| camelCase options/results | Modern SDK uses server snake_case | Source/schema migration, not lost functionality |
| Legacy `created` values | Legacy deserializes as `Date`; modern preserves numeric server timestamps | Response-consumer migration needed |
| Azure Core policy pipeline and KeyCredential wrappers | Modern SDK uses request options/custom fetch and its own auth configuration | Not a drop-in client API; adapt integration code |

Passing mock responses prove client serialization/deserialization, not service
acceptance, regional/model availability, successful token authorization, or
semantic equality of generated answers. Known type gaps are measured explicitly
by regression tests; their presence does not make the entire CI suite fail.

## Live tests

The separate `Azure and OpenAI live compatibility` workflow is manual,
`main`-only, requires explicit paid-test confirmation, and uses the `openai-live`
environment. It is not enabled by ordinary PRs, pushes, or scheduled discovery.
It does not depend on filling the original 281-endpoint catalog.

The default three suites (`chat`, `chat-stream`, `embeddings`) make calls from:

1. The legacy Azure client to Azure.
2. Both pinned `AzureOpenAI` clients to the same Azure deployments.
3. Both pinned plain `OpenAI` clients to the public OpenAI API.

That is 15 inference calls by default, with no automatic retries. Text must be
nonempty; streams must have a finish reason; embeddings must be finite numeric
vectors with consistent dimensions across SDKs targeting the **same provider**.
No exact answer match or cross-provider embedding equality is assumed.

Optional suites are `completions`, `completions-stream`, `images`,
`transcription`, `translation`, `on-your-data`, and `azure-filters`.
Choose only suites supported by your actual deployments/API version. Optional
legacy text-completion and image/audio suites may fail because models/APIs have
retired; that is reported, not silently skipped.

`on-your-data` compares Azure Search grounding/citations only on Azure. Configure
`dataSources` using the modern `azure_search` shape; the runner translates the
legacy request shape. `azure-filters` explicitly requires Azure prompt/choice
filter metadata; deployments not returning it fail that case.

For image/audio/text completion suites, add corresponding keys to both
`azureDeployments` and `openaiModels`: `images`, `transcription`, `translation`,
or `completions`. Audio suites also require an `audioFile` relative to the
repository's `fixtures` directory. Supply a permitted, non-sensitive spoken WAV
fixture; the included text file is not audio. No audio files or credentials are
generated automatically.

Live output is `reports/azure-live.json`. Only case IDs, statuses, numeric
embedding dimensions, and redacted error categories/status codes are persisted.
Raw prompts, generated text, response bodies, endpoint URLs, and secret values
are not uploaded. Failed auth, absent metadata, or assertion errors fail the run.
This is selected live coverage, not exhaustive API parity.

### Stable Azure companion live comparison

Select workflow **mode: `azure-companion`** to run only the stable
`@azure/openai` scenarios against Azure, without changing your Key Vault JSON.
The default `configured` mode preserves the existing suites, including a
Responses-only secret. Companion mode selects `chat,chat-stream` by default.
Set `companion_chat_deployment` to a deployment supporting Chat Completions if
the secret has no `azureDeployments.chat`; Responses support alone does not
establish Chat Completions support. This makes **four Azure requests**: two
scenarios on each pinned OpenAI SDK. No OpenAI-hosted or legacy client calls
are made in companion-only mode, and no OpenAI key is required.

Alternatively, include `"azure-companion"` in the secret's `suites` and add:

```json
{
  "azureDeployments": { "chat": "YOUR-CHAT-DEPLOYMENT" },
  "azureCompanion": {
    "features": ["chat", "chat-stream"],
    "tokenParameter": "max_completion_tokens",
    "maxTokens": 128
  }
}
```

Keep the existing Azure endpoint, API version, and key/Entra configuration.
Use `max_tokens` instead for deployments that require it. This suite uses
Azure versioned routes. Model names, keys, data sources, and grounded questions
remain in memory; the workflow override does not write the secret.

| Selectable companion feature | Fields/behavior checked | Additional requirements |
|---|---|---|
| `chat`, `chat-stream` | Prompt/choice content-filter metadata, including SSE chunks | Chat deployment |
| `grounding`, `grounding-stream` | `data_sources` serialization and message/delta citation context | `dataSources` with a real Azure Search endpoint, index, authentication, and `azureCompanion.groundingPrompt` that can be answered from that index |
| `completions` | Text-completion prompt/choice filters | `azureDeployments.completions` and a compatible legacy text-completion model |
| `images` | Image prompt/content-filter fields | `azureDeployments.images` and supported image generation |
| `upload-parts` | `azure_block_id` on an uploaded part | Uploads API support; uploads a tiny synthetic file, cancels the pending upload, and verifies cancellation without completing a persistent File |

These seven scenarios cover all **13 declared companion fields**, not every
Azure feature or SDK API. Selecting all seven produces 14 scenario results
and 18 HTTP requests, including upload creation, part upload, and cancellation.
Missing deployment/source prerequisites block all paid suites before requests.
Azure service rejection is a nonpassing result, not an automatic SDK defect.
No new deployments, Search indexes, or other Azure resources are provisioned.

`compat/azure-companion-scenarios.mts` genuinely imports the stable companion,
is type-checked against each pinned SDK, and is transpiled before execution.
Independent compiler probes compare native versus augmented typing at **actual
request/response call sites**, not just root exports. The upload scenario uses
reflective access for the known remaining method-result typing gap and reports
that limitation rather than hiding it with a type assertion.

For each selected Azure field, a fetch wrapper compares original request/response
JSON or raw SSE metadata with the values consumed by the typed scenario.
The readable summary separates typing gaps, fields preserved by the SDK,
wire-versus-SDK mismatches, fields Azure did not emit, and fields not selected.
Absent service metadata is **unverified**, never a pass or evidence of SDK
data loss. Failed functional assertions (including missing grounding citations)
do not produce misleading runtime-loss findings. Unverified or failed selected
cases make the run nonpassing. Successful selected cases remain partial coverage.
Only field IDs, observed counts, typing flags, safe assertion categories,
HTTP statuses, and outcomes are persisted; raw values are never uploaded.

## Responses feature matrix and gap reporting

```powershell
npm run test:responses
npm run responses:report
```

The pinned snapshots inventory **848 features/fields in 7.3.0 and 923 in
7.45.1**. Every reviewed fixture is compiled with and without the Azure
companion and executed using real SDK clients with injected HTTP transports
against public OpenAI, Azure versioned, and Azure `/openai/v1` routes.
These are offline contracts, not recorded service successes.

The inventory covers all nine Responses methods (including `parse`, `stream`,
compaction, token counts, and input-item listing), every declared tool, input,
output, content, format, tool-choice, status, and stream-event variant, plus
individual fields of those variants, top-level request/response fields, and
nested reasoning/text/cache/moderation/context/prompt controls. Referenced shared
declarations are fingerprinted too. This does not exhaust every recursively
nested property, parameter combination, or possible model-generated outcome.
Schema changes fail review coverage even when an existing sample still compiles.

`reports/responses-compatibility.json` and the GitHub job summary explicitly show:

- The 13 native Azure declaration gaps per pinned OpenAI version, whether
  importing the companion patches each declaration, and actual client-call
  typing (including the unresolved upload method result); legacy `enhancements`
  is separate.
- **Zero Responses extensions from this stable Azure companion**. The legacy
  standalone Azure client has no Responses resource; it is not an equivalent
  Responses implementation and is not counted as a passing target.
- The 76 additions and one removal between pinned Responses surfaces. The removed
  field is `response.function_call_arguments.done.name`; raw JSON preservation
  and whether a field remains natively typed are different questions.
- Raw streaming `event: error` behavior: 7.3.0 yields the event while 7.45.1 throws
  an SDK API error. Both behaviors are explicitly regression-tested.
- Raw JSON Schema streaming parsing: 7.3.0 leaves `output_parsed` null while
  7.45.1 parses the final object. This is a separate helper behavior change.
- Missing contracts, unreviewed declaration changes/removals, and live fixture
  requirements. Known reviewed differences remain visible without permanently
  failing CI; new unreviewed changes fail.

The job summary separates **SDK compatibility findings - offline checks** from
**Live API results**. The offline section explains what packages were compared,
groups Azure typing gaps by capability with their remedies, and explains how SDK
behavior changes affect application code. Raw field inventories are expandable
details, not a list of failed live tests. The live section provides an overall
verdict and a feature-by-SDK/provider result table, explains partial coverage and
nonpassing statuses, and states what was not measured.

The live workflow uploads `sdk-compatibility-details` for the offline JSON and
`azure-live-results` for live case outcomes. No extra inference calls are needed
to generate either summary. A completed workflow's existing summary is not
rewritten by changing the code; the new format appears on future runs.

Daily release discovery runs **offline Responses contracts sequentially for every
discovered published version**. `npm run responses:versions` does the same
locally; `FROM_VERSION`/`TO_VERSION` can narrow it. It writes per-version JSON
reports and restores pinned dependencies afterwards. New fixture/schema slots
are drafts, never silently accepted. Generated review obligations are included
in the existing draft release PR. `npm run responses:catalog` regenerates draft
inventory; `-- --accept-contracts` is an explicit human-review acceptance step,
not proof that live service tests have run.

### Optional live Responses execution

To extend the earlier three-method live run to all nine core methods, select
**mode: `responses-core`** in the manual live workflow. This changes only the
in-memory selection, without editing the Key Vault secret. It runs only
Responses, preserving the configured `azureApiMode` (`v1`, `versioned`, or
`both`), models, credentials, per-method overrides, and private fixtures.
Both pinned SDK versions run against Azure and the OpenAI-hosted API: **36
method-by-target outcomes** with one Azure route, or **54** with both routes.
These are scenario counts, not HTTP request or inference counts: setup,
pagination, verification, and cleanup make additional requests.

The six additional methods are:

| Method | Actual live assertion |
|---|---|
| `responses.retrieve()` | Stored response ID and output text survive retrieval; stored state is deleted afterward |
| `responses.delete()` | Deletion succeeds and subsequent retrieval returns 404 |
| `responses.cancel()` | A queued/in-progress background response is cancelled, the returned ID matches, and stored state is deleted |
| `responses.compact()` | A compaction response contains an encrypted compaction item |
| `responses.inputItems.list()` | A second page is fetched and its item ID differs; stored state is deleted |
| `responses.inputTokens.count()` | The result has a positive integer input-token count |

Cancellation requires a background-capable model and a still-running response;
if it finishes before cancellation, the case fails rather than claiming that
cancellation was tested. Compaction and token counting need provider/model/API
support. Preserve dedicated per-provider `responses.cases[featureId].azure`
and `.openai` overrides from your secret if these methods need different models
or request bodies. Unsupported/rejected calls remain nonpassing findings,
not automatic SDK defects, and are not silently skipped.

The all-nine preset remains `mode: selected` in the Responses report:
**9/9 core methods is not the full Responses feature matrix or all OpenAI APIs**.
All nine must actually pass on every compared target before the summary reports
9/9 verified; selecting the preset alone does not close live coverage gaps.
The default workflow mode `configured` still uses your existing secret unchanged.

For a narrow rerun, set the optional workflow `responses_features` input, for
example `method:delete,method:inputItems.list,method:inputTokens.count`.
It applies only to `responses-core`; leaving it blank selects all nine.
Unknown/duplicate feature IDs still fail preflight. Existing provider routes,
models, and per-feature overrides are retained, and the secret is not modified.

Deletion accepts a valid JSON `response.deleted` acknowledgment or an empty
204 response, then verifies that retrieving the deleted resource returns 404.
It does not assume a `null` return just because the pinned SDK declarations say
`void`. Successful deletion is removed from pending cleanup before validating
the acknowledgment, preventing a second DELETE of an already-deleted resource.

Failure diagnostics retain the operation (including first/next input-item page
and cleanup), allowlisted service codes/parameter names, and a fixed set of
recognized service-message hints. Original error messages, response IDs, model
names, endpoint URLs, and credentials are not stored. A 404 alone cannot tell
whether a route, response, or cursor was missing; a 400 alone cannot establish
an SDK defect. Read the redacted failed-step details before drawing conclusions.

Add `"responses"` to the Key Vault configuration's `suites`, add a
`responses` deployment/model to both `azureDeployments` and `openaiModels`,
and add, for example:

```json
{
  "responses": {
    "mode": "selected",
    "azureApiMode": "v1",
    "features": ["method:create", "method:parse", "method:stream"]
  }
}
```

`azureApiMode` must explicitly be `v1`, `versioned`, or `both`. Azure v1 uses
the plain OpenAI client; versioned routes use `AzureOpenAI`. Both pinned SDKs run
against Azure and public OpenAI; there is no legacy Azure Responses target.
Entra scopes are selected separately for the Azure v1 and versioned routes.

Fourteen authored functional cases cover the nine methods, structured/text
formats, function-call argument/result round trips, and previous-response state.
Stored state is deleted even after an assertion failure; cleanup failures fail
the case. Pagination traverses a second input-item page. Cancellation must
actually exercise a queued/in-progress response; a response that finishes first
does not pass the cancellation test. Override a builtin's `body`, `model`, or
additional response `assertions` under
`responses.cases[featureId][azure|openai]` when a dedicated deployment needs them.
For example, background/cancel, compaction, and JSON mode may require different
models or API versions; builtin availability is not a service-support claim.

For exhaustive fixture obligations use `"mode": "full"` and omit `features`.
`compat/responses-live.template.json` lists all remaining per-provider fixture
slots. Copy and author non-secret scenarios inside `fixtures`, then configure
`responses.caseFile` relative to that directory. The file is not automatically
executed just because it exists. `fixtures/responses.example.json` shows an
assertion-bearing scenario and feature evidence. It intentionally leaves the
public OpenAI equivalent unreviewed.

Scenarios use the existing `$env`, `$ref`, and `$file` directives. `$env` resolves
only from `responses.values` in the in-memory Key Vault config plus the selected
provider's `RESPONSES_MODEL`, not arbitrary runner environment variables. Keep
secrets in those values, never in committed scenarios. Response creation must
explicitly disable storage or provide deletion cleanup. Use the builtin adapter
for `method:stream`; the helper is not an HTTP APIPromise.
An authored `event:error` scenario may additionally declare
`"expectedError": { "code": "THE_EXPECTED_SERVICE_EVENT_CODE" }` to compare a
yielded SSE error in older SDKs with a typed stream exception in newer ones.
Only that exact code on a status-less SDK SSE error is accepted; HTTP/auth
failures, assertion errors, and cleanup failures are never converted to passes.

Missing/invalid fixtures block **all suites before any paid call** and list
feature/provider IDs in `reports/azure-live.json`. A selected run is always
reported as incomplete matrix coverage even if its cases pass. A full run
cannot silently select a subset. Explicit unsupported declarations require
`unsupported: true`, a nonempty `reason`, and `classification` equal to
`service-limitation`, `model-limitation`, or `api-version-limitation`; these are
configuration declarations, not live verification and not passes.
Absent SDK surface, service HTTP rejection, assertion failure, and missing
fixtures have distinct statuses. Any nonpassing result fails the live workflow.
Service errors are not automatically labeled as native SDK gaps.

The full live matrix needs provider/model-specific resources and assertions for
hosted tools, image/file inputs, MCP approvals, saved prompts, optional fields,
and exceptional stream states. Generated schema samples contain fictional IDs
and are **never sent to live services**. No live Responses parity is claimed
until those fixtures are configured and actual runs pass. Large full matrices
must fit the manual workflow's 45-minute budget or be run as explicitly partial
selected batches; partial batches do not become full coverage automatically.

## Key Vault + GitHub OIDC

Credentials stay in Azure Key Vault. No Azure client secret or API key needs to
be stored in GitHub:

1. Create a dedicated Entra application/service principal or user-assigned
   managed identity. Add a GitHub federated credential with issuer
   `https://token.actions.githubusercontent.com` and audience
   `api://AzureADTokenExchange`. The subject must match this repository and the
   `openai-live` environment.
2. This repository currently uses immutable OIDC subjects. The observed subject
   is
   `repo:KarishmaGhiya@8968058/openai-sdk-compat-tests@1416271536:environment:openai-live`.
   Verify using
   `gh api repos/KarishmaGhiya/openai-sdk-compat-tests/actions/oidc/customization/sub`
   before provisioning; forks and changed OIDC policies need their own subject.
3. Assign **Key Vault Secrets User** on a dedicated test vault (or a narrower
   supported secret scope). Do not grant subscription Contributor or vault
   secret-write permissions for this workflow.
4. Create `openai-live` in GitHub Environments. Restrict it to `main` and add a
   required reviewer for paid execution. Protect `main` and review workflow/test
   changes: once authorized, runner code can access the fetched credentials.
5. Add these **environment variables** under `openai-live`, not API-key secrets:
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
   `AZURE_KEYVAULT_URL` (for example `https://your-vault.vault.azure.net`), and
   optionally `AZURE_COMPAT_SECRET_NAME` (defaults to
   `openai-azure-compat-config`).
6. Store one JSON secret named `openai-azure-compat-config` in Key Vault.
   Start with `compat/azure-live.example.json`; fill real values **only in Key
   Vault or a private temporary file**, never the committed example. Use the
   Azure portal secret editor or your normal secure provisioning process.

The JSON secret contains both provider API keys, endpoint, API version,
deployment/model names, selected suites, and any grounding configuration. For
keyless Azure inference set `"azureAuth": "entra"` and **remove** `azureApiKey`.
Assign the federated identity **Cognitive Services OpenAI User** on the Azure
OpenAI resource as well as Key Vault read permission. The public OpenAI API
still requires its API key from the vault.

The workflow runs pinned `azure/login` using OIDC. The Node runner uses
`AzureCliCredential` for that logged-in identity, fetches the JSON secret through
`SecretClient`, masks the raw JSON and each string value, validates configuration,
and passes it directly to the live runner in memory. It does not write secrets
to `$GITHUB_ENV`, job outputs, fixtures, or artifacts. Changing the vault secret
rotates configuration without committing a repository change.

Public-cloud resource root endpoints are supported by this initial workflow.
Private vaults/inference endpoints require a network-connected runner; OIDC
does not bypass firewalls. Sovereign-cloud endpoints/scopes require explicit
configuration changes. This task does not provision Azure resources, assign RBAC,
configure the environment, or run billable tests automatically.

Local run after `az login`, using PowerShell:

```powershell
$env:AZURE_KEYVAULT_URL = 'https://your-vault.vault.azure.net'
$env:ALLOW_LIVE_API = 'true'
npm run test:azure:keyvault
```

For an already-injected private configuration, `npm run test:azure:live` also
accepts `AZURE_COMPAT_CONFIG_JSON`. Do not paste that JSON into chat or logs.

## References

- [Azure SDK overview](https://learn.microsoft.com/en-us/javascript/api/overview/azure/openai-readme?view=azure-node-latest)
- [Azure JavaScript migration guide](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/openai/openai/MIGRATION.md)
- [Key Vault with GitHub OIDC](https://learn.microsoft.com/en-us/azure/developer/github/github-actions-key-vault)
