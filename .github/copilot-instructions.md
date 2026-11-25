# Copilot instructions

This repository tests published `openai` Node SDK releases against the OpenAI API and Azure OpenAI.

- Node.js 24, ES modules (`.mjs`), no build step. Install with `npm ci --ignore-scripts`; run `npm test` (offline, no credentials) before finishing.
- `package.json` pins the baseline `openai` (7.3.0) and comparison `openai-current`. Don't change those pins; workflows install other versions at run time.
- Generated inventory: `npm run discover` updates `releases.json`, `cases/catalog.json`, and `fixtures/template.json`. It never overwrites reviewed cases. Set `NPM_REGISTRY=https://registry.npmjs.org`.
- Release-feature cases need steps, assertions, and an `evidence` map from each obligation ID (`changelog:<version>:<id>`) to assertion-bearing step IDs. The case format is in `README.md` under "Configure real API tests".
- Offline contracts use injected transports: Responses in `lib/responses-contract.mjs` / `tests/responses-contract.test.mjs`; Azure in `compat/` and `tests/azure-*.test.mjs`. Live runners are `lib/responses-live.mjs` and `lib/azure-live.mjs`.
- Never commit credentials, endpoint URLs, response bodies, or real fixture values, and never set `ALLOW_LIVE_API`.
- Keep files' existing line endings. Add tests to existing test files where one fits.
