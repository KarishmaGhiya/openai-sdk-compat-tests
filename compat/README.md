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
| Azure `data_sources`, prompt/choice filter results, citation context, image filter results, and `azure_block_id` | 13 fields absent natively; all 13 type-check with the Azure companion | Type-extension dependency, not lost runtime data |
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
