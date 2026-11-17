import { SecretClient } from '@azure/keyvault-secrets';
import { AzureCliCredential } from '@azure/identity';
import { validateVaultConfig, withKeyVaultConfig } from '../lib/azure-keyvault.mjs';
import { CompanionPrerequisiteError } from '../lib/azure-companion-live.mjs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../lib/io.mjs';
import { main, writeCompanionPreflight, writeLiveReport } from './azure-live.mjs';

let liveStarted = false;
try {
  await unlink(join(root, 'reports', 'azure-live.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  const vaultURL = process.env.AZURE_KEYVAULT_URL;
  const secretName = process.env.AZURE_COMPAT_SECRET_NAME ?? 'openai-azure-compat-config';
  validateVaultConfig(vaultURL, secretName);
  await withKeyVaultConfig({
    vaultURL, secretName,
    client: new SecretClient(vaultURL, new AzureCliCredential(), { retryOptions: { maxRetries: 0 } }),
    run: async (raw) => {
      liveStarted = true;
      await main(raw);
    },
    allowLive: process.env.ALLOW_LIVE_API === 'true',
    mask: (value) => {
      if (process.env.GITHUB_ACTIONS === 'true') {
        const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
        console.log(`::add-mask::${escaped}`);
      }
    },
  });
} catch (error) {
  if (error instanceof CompanionPrerequisiteError) {
    await writeCompanionPreflight(error);
  } else {
    await writeLiveReport({
      live: false, blockedBeforePaidCalls: !liveStarted,
      setupFailure: liveStarted ? 'execution' : 'keyvault-or-config', results: [],
    });
    console.error('Key Vault/live compatibility setup failed. Check authorization, network access, and configuration. Details redacted.');
    process.exitCode = 1;
  }
}
