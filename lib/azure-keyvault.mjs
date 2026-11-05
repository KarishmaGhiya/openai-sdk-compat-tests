import { validateLiveConfig } from './azure-live.mjs';

export function validateVaultConfig(vaultURL, secretName) {
  let url;
  try { url = new URL(vaultURL); } catch { throw new Error('Set AZURE_KEYVAULT_URL to the vault HTTPS URL.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.vault\.azure\.net$/i.test(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.port || !['', '/'].includes(url.pathname)) {
    throw new Error('Expected a public-cloud Azure Key Vault root URL.');
  }
  if (typeof secretName !== 'string' || !/^[a-zA-Z0-9-]{1,127}$/.test(secretName)) {
    throw new Error('Invalid AZURE_COMPAT_SECRET_NAME.');
  }
}

export function maskValues(value, mask) {
  if (typeof value === 'string') {
    if (value) mask(value);
  } else if (Array.isArray(value)) {
    for (const item of value) maskValues(item, mask);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) maskValues(item, mask);
  }
}

export async function withKeyVaultConfig({ vaultURL, secretName, client, run, mask, allowLive }) {
  if (allowLive !== true) throw new Error('Authorize paid live execution before reading credentials.');
  validateVaultConfig(vaultURL, secretName);
  const secret = await client.getSecret(secretName);
  if (typeof secret.value !== 'string' || !secret.value.trim()) throw new Error('Key Vault secret is empty.');
  mask(secret.value);
  let config;
  try { config = JSON.parse(secret.value); } catch { throw new Error('Invalid Key Vault JSON configuration; value redacted.'); }
  maskValues(config, mask);
  validateLiveConfig(config);
  return run(secret.value);
}
