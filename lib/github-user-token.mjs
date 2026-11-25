// GitHub App user-to-server tokens: the only App-based token GitHub accepts for assigning issues to the Copilot coding agent.
// Access tokens expire after 8 hours; each refresh returns a new single-use refresh token that must be saved before use.

const oauth = 'https://github.com/login';

async function post(fetchImpl, path, body) {
  const response = await fetchImpl(`${oauth}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  return { ok: response.ok, result };
}

export async function refreshUserToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const { ok, result } = await post(fetchImpl, '/oauth/access_token', {
    client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken,
  });
  if (!ok || result.error || !result.access_token || !result.refresh_token) {
    throw new Error(`GitHub App user token refresh failed (${result.error ?? 'missing tokens'}). Re-run npm run copilot:authorize.`);
  }
  return { accessToken: result.access_token, refreshToken: result.refresh_token };
}

// Saves the rotated refresh token before returning the access token, so a later failure cannot lose the chain.
export async function rotateUserToken({ secrets, clientId, clientSecretName, refreshTokenName, mask = () => {}, fetchImpl = fetch }) {
  const [clientSecret, refreshToken] = await Promise.all([
    secrets.getSecret(clientSecretName), secrets.getSecret(refreshTokenName),
  ]).then((values) => values.map((secret) => secret.value));
  const tokens = await refreshUserToken({ clientId, clientSecret, refreshToken, fetchImpl });
  mask(tokens.accessToken);
  mask(tokens.refreshToken);
  await secrets.setSecret(refreshTokenName, tokens.refreshToken);
  return tokens.accessToken;
}

export async function deviceAuthorize({ clientId, fetchImpl = fetch, prompt = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { ok, result: code } = await post(fetchImpl, '/device/code', { client_id: clientId });
  if (!ok || !code.device_code) throw new Error(`Device flow could not start (${code.error ?? 'no device code'}). Enable device flow in the App settings.`);
  prompt(`Open ${code.verification_uri} and enter code ${code.user_code}`);
  let interval = (code.interval ?? 5) * 1000;
  for (const deadline = Date.now() + code.expires_in * 1000; Date.now() < deadline;) {
    await sleep(interval);
    const { result } = await post(fetchImpl, '/oauth/access_token', {
      client_id: clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval += 5000; continue; }
    if (result.error) throw new Error(`Device authorization failed (${result.error}).`);
    if (!result.refresh_token) throw new Error('No refresh token returned. Enable "Expire user authorization tokens" in the App settings.');
    return { accessToken: result.access_token, refreshToken: result.refresh_token };
  }
  throw new Error('Device code expired before authorization.');
}
