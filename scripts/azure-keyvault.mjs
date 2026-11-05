import { SecretClient } from '@azure/keyvault-secrets';
import { AzureCliCredential } from '@azure/identity';
import { validateVaultConfig, withKeyVaultConfig } from '../lib/azure-keyvault.mjs';
import { main } from './azure-live.mjs';

try {
  const vaultURL = process.env.AZURE_KEYVAULT_URL;
  const secretName = process.env.AZURE_COMPAT_SECRET_NAME ?? 'openai-azure-compat-config';
  validateVaultConfig(vaultURL, secretName);
  await withKeyVaultConfig({
    vaultURL, secretName,
    client: new SecretClient(vaultURL, new AzureCliCredential(), { retryOptions: { maxRetries: 0 } }),
    run: main,
    allowLive: process.env.ALLOW_LIVE_API === 'true',
    mask: (value) => {
      if (process.env.GITHUB_ACTIONS === 'true') {
        const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
        console.log(`::add-mask::${escaped}`);
      }
    },
  });
} catch {
  console.error('Key Vault/live compatibility setup failed. Check authorization, network access, and configuration. Details redacted.');
  process.exitCode = 1;
}
