# OpenAI Node SDK live compatibility

This standalone suite discovers stable `openai` releases starting at **7.3.0**.
It inventories public HTTP endpoint methods using both `api.md` and the reachable
resource graph in the tagged TypeScript source: `api.md` alone omits some methods.
It generates endpoint tests with response-shape assertions, compares request,
response, model-enum, and public helper signatures, and records every changelog
feature as a separate coverage obligation.

**Current status:** endpoint contract cases and fixture slots are generated for
all inventoried APIs. Eight reviewed smoke scenarios exercise models, Responses
(including streaming), stored Chat Completions, embeddings, moderation, files,
and vector stores. The remaining endpoint scenarios require account-specific
arguments and review; release-feature scenarios require semantic assertions.
Generated drafts are **not passing tests or coverage**. No live requests have
been validated without your credentials and fixtures.

## Commands

Use Node.js 22 or later; workflows use Node.js 24.

```sh
npm ci --ignore-scripts
npm test
npm run discover
npm run coverage
npm run test:versions
```

- `npm test` runs offline regression tests, including the actual installed SDK
  with an injected HTTP transport. These tests do not call OpenAI.
- `discover` reads upstream tags and npm publication status, generates
  `releases.json`, `cases/catalog.json`, and `fixtures/template.json`, and leaves
  existing cases (including partially authored ones) unchanged. A previously recorded tag changing/disappearing is
  an error. Publication without a matching source tag is also an error.
- `coverage` fails for missing endpoint tests, missing feature evidence,
  unreviewed cases, absent fixture arguments, or removed baseline endpoints.
- `test:versions` installs each exact published version into this workspace,
  **sequentially**, starting at 7.3.0, then 7.4.0 and every subsequent published
  version. Cases apply from their `since` version; earlier feature tests carry
  forward. All version failures are recorded; later versions still run.
  SDK installation uses `--no-save --package-lock=false --ignore-scripts`.
  Run `npm ci --ignore-scripts` afterward to restore the baseline installation.

`FROM_VERSION` and `TO_VERSION` can narrow a manual run. `SDK_VERSION` selects a
single installed version for `npm run test:live`. `NPM_REGISTRY` explicitly
selects a registry; GitHub Actions uses the public registry. Tagged-but-unpublished
versions are inventoried, not installed. Missing versions are reported, never
substituted with a nearest version. `DISCOVERY_OFFLINE=true` explicitly reuses
previously fetched source tags and recorded publication status; it does not
check for new releases.

## Configure real API tests

Use a **dedicated disposable test organization/project**, not production.
These tests can incur charges, create resources, delete fixtures, launch jobs,
and require organization-owner/admin or restricted feature permissions.
No retry is made for paid/mutating calls. Fine-tuning, batches, evals, uploads,
realtime calls, and administrative APIs need valid resource fixtures and
appropriate lifecycle scenarios; do not reuse identifiers across versions.
Protect the test project with server-side budget/rate limits. A per-step timeout
cannot limit backend job charges or guarantee cleanup after a runner is killed.

Copy `fixtures/template.json` to the gitignored `fixtures/live.json` and fill
argument arrays. Credentials belong in environment variables, never in committed
JSON. Review each generated endpoint case, improve its response assertions, add
setup/cleanup as needed, and only then set `ready: true`. You may combine
multiple endpoint obligations in one lifecycle case, as the built-in scenarios
do. Unused draft cases do not block coverage when another reviewed scenario
actually covers the same obligation.

Each step declares a method, arguments (or a fixture key), `optionsIndex`,
assertions, and an optional capture mode. `optionsIndex` is zero-based and
generated from the actual implementation, not guessed from function length or
an overload; it is where timeout/abort/no-retry request options are inserted.
Fixture argument arrays **exclude request options**. For example:

```json
{
  "endpoint:models.retrieve": {
    "args": [{ "$env": "OPENAI_TEST_TEXT_MODEL" }]
  }
}
```

Supported fixture directives:

- `{ "$env": "NAME" }`: required environment variable.
- `{ "$ref": "created.id" }`: value from an earlier step in the same scenario.
- `{ "$file": "sample.txt", "type": "text/plain" }`: multipart `toFile` input;
  paths must stay inside the fixture directory.
- `{ "$literal": { "your": "object" } }`: do not interpret nested directives.

Assertions support `exists`, `equals`, `type`, `nonEmpty`, `includes`,
`greaterThan`, and `matches`, using dot-delimited paths. Capture modes are
`json` (default), `text`, `bytes`, and fully consumed `stream`. Cleanup steps
always run after failure; `when: "created.id"` guards against deleting resources
whose creation failed. Cleanup errors also fail the scenario.

Release-feature cases list exact obligations from type diffs and changelog
features. Add steps exercising the actual changed behavior and an `evidence`
map from **each** obligation ID to the assertion-bearing step IDs. For example:

```json
{
  "evidence": {
    "changelog:7.4.0:REPLACE_WITH_GENERATED_ID": ["new-feature-response"]
  }
}
```

Coverage checks that evidence is present; a human must review that the assertions
really test the feature. It cannot infer arbitrary new semantics from release
notes. Helper-only, type-only, inbound-webhook, and persistent WebSocket features
may require a new specialized test rather than the default APIPromise endpoint
runner. Such gaps remain explicit until implemented; copying an unrelated
successful HTTP assertion does not establish semantic coverage.

Set `OPENAI_API_KEY`, `OPENAI_ADMIN_API_KEY` where needed,
`OPENAI_TEST_TEXT_MODEL`, and `OPENAI_TEST_EMBEDDING_MODEL`, plus any fixture
environment variables. `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are optional.
Authorize execution using `ALLOW_LIVE_API=true`. `OPENAI_BASE_URL` cannot be a
mock/proxy. Full runs require a completely configured 7.3.0 baseline **before
any billable request**. Missing tests for newly added features do not suppress
the configured baseline/regression tests on a newer SDK: those tests still run,
but the version fails overall until the new coverage gaps are filled.

For bootstrap only, `LIVE_CASES=smoke:models,smoke:embeddings` with
`npm run test:live` selects configured smoke scenarios. Reports mark such runs
**partial**, not full compatibility. Partial selection is forbidden in
`test:versions` and is not exposed by the release workflow.

## GitHub Actions

Push this directory as a GitHub repository with default branch `main`.

1. Create an `openai-live` environment. Add `OPENAI_API_KEY`, optional
   `OPENAI_ADMIN_API_KEY`, and `LIVE_FIXTURES_JSON` (the contents of your private
   `fixtures/live.json`) as environment secrets. Configure any additional
   fixture environment variables explicitly in the workflow. Non-sensitive
   fixture files can be committed under `fixtures/`.
2. Set repository variable `LIVE_ENABLED=true` to enable automatic paid live
   runs. Configure environment variables for model/project selection as needed.
   GitHub environment approval rules, if enabled, will pause automatic runs.
3. Enable Actions permissions to create pull requests. Optionally add
   `RELEASE_PR_TOKEN`, a repository-scoped fine-grained token with contents and
   pull-request write permissions, so generated PRs trigger CI. The default
   `GITHUB_TOKEN` cannot trigger further workflows.

`ci.yml` tests the harness on Linux and Windows without secrets and uploads
inventory gaps. This check does not falsely fail the harness just because live
fixtures have not been configured.

`releases.yml` polls daily and can be dispatched manually. New releases produce
a draft PR containing generated test cases, fixture slots, and feature
obligations. It never overwrites reviewed tests or an existing open automation
PR. Merge/close the existing PR before generating another. Automatic live runs
start after detecting a new published release, and after relevant changes merge
to `main`; manual dispatch defaults to the complete range. All versions in that
range run in release order, not a parallel matrix, to avoid shared-fixture races.

Reports in `reports/` contain per-version coverage and live outcomes, with no
raw response bodies, fixture values, or API error messages. A failed authentication,
missing fixture, assertion failure, cleanup failure, or coverage gap remains
a failure, not a skipped/pass-shaped result.

The initially recorded publication state comes from the local registry mirror,
which exposed versions only through 7.25.0; upstream tags extend through 7.30.0.
The first online GitHub run rechecks the public registry rather than assuming
the mirror's publication state is current.
