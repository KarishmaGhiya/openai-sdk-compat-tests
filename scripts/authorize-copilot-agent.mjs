// One-time local setup: authorize the issue-filing GitHub App as yourself and store its refresh token in Key Vault.
// Usage: az login, then AZURE_KEYVAULT_NAME=<vault> ISSUES_APP_CLIENT_ID=<client id> npm run copilot:authorize
import { SecretClient } from '@azure/keyvault-secrets';
import { AzureCliCredential } from '@azure/identity';
import { deviceAuthorize } from '../lib/github-user-token.mjs';

const { AZURE_KEYVAULT_NAME: vault, ISSUES_APP_CLIENT_ID: clientId } = process.env;
const secretName = process.env.COPILOT_REFRESH_TOKEN_SECRET_NAME ?? 'copilot-agent-refresh-token';
if (!vault || !clientId) throw new Error('Set AZURE_KEYVAULT_NAME and ISSUES_APP_CLIENT_ID.');

const { accessToken, refreshToken } = await deviceAuthorize({ clientId });
const user = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${accessToken}` } }).then((r) => r.json());
await new SecretClient(`https://${vault}.vault.azure.net`, new AzureCliCredential()).setSecret(secretName, refreshToken);
console.log(`Authorized as ${user.login}; stored the refresh token in ${vault}/${secretName}.`);
