const keptWords = new Set([
  'input_tokens', 'input_items', 'previous_response_id', 'max_output_tokens', 'api-version', 'invalid_request_error',
  'server_error', 'not_found_error', 'tool_choice', 'response_format', 'json_schema', 'json_object', 'v1',
]);
const serviceTypes = new Set([
  'invalid_request_error', 'server_error', 'not_found_error', 'authentication_error', 'permission_error',
  'rate_limit_error', 'api_error', 'tokens_exceeded_error',
]);

// Keeps the service's wording while removing values that can identify resources: quoted text, URLs, hosts,
// IDs, model/deployment names, and any configured secret. Identifier-like words (digits, '-', '_', '.', '/', ':')
// are replaced unless they are fixed API vocabulary.
export function sanitizeServiceMessage(message, secrets = []) {
  if (typeof message !== 'string' || !message.trim()) return undefined;
  let text = message.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('{value}');
  }
  text = text
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '{value}')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '{url}')
    .replace(/\S*[\w-]+@[\w-]+\.\S+/g, '{value}')
    .replace(/[^\s,;!?(){}[\]]+/g, (word) => {
      const core = word.replace(/[.:]+$/, '');
      const tail = word.slice(core.length);
      if (!core || keptWords.has(core.toLowerCase()) || core === '{value}' || core === '{url}') return word;
      return /[\d_/:.\\-]|^[A-Z0-9]{12,}$/.test(core) || core.length > 40 ? `{value}${tail}` : word;
    })
    .replace(/[<>|"'`\\]/g, '');
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function serviceType(error) {
  const type = error?.error?.type ?? error?.type;
  return serviceTypes.has(type) ? type : undefined;
}

export function serviceRequestId(error) {
  const headers = error?.headers;
  const read = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]);
  const id = read('apim-request-id') ?? read('x-ms-request-id') ?? error?.requestID ?? read('x-request-id');
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : undefined;
}

export function isStoredResponseNotFound(error) {
  const message = error?.error?.message ?? error?.message;
  return error?.status === 404 && typeof message === 'string' &&
    /\bnot found\b|does not exist|could not be found/i.test(message) && !/unknown request url|no route matched/i.test(message);
}

export function knownServiceCause({ status, message, operation, code, retriedForMs }) {
  if (typeof message !== 'string') message = '';
  if (status === 400 && /model is not supported|unsupported model|model .*not supported/i.test(message)) return 'model-unsupported-for-operation';
  if (status === 404 && Number.isInteger(retriedForMs) &&
    ['responses.inputItems.list', 'responses.retrieve'].includes(operation)) return 'stored-response-not-found-after-retry';
  if (status === 404 && /unknown request url|no route matched/i.test(message)) return 'route-not-available';
  if (code === 'DeploymentNotFound' || (status === 404 && /deployment .*does not exist|deployment.*not found/i.test(message))) return 'deployment-not-found';
  return undefined;
}

export const knownCauses = {
  'model-unsupported-for-operation': {
    category: 'API limitation: model not supported for this operation',
    cause: 'Service says this model is not supported for this operation. Use a model/deployment that supports it, or record it as a service limitation; not an SDK defect.',
  },
  'stored-response-not-found-after-retry': {
    category: 'API issue: stored response not found after retries',
    cause: 'The stored response stayed not found for the whole retry window, so this is not a short read-after-write delay. Investigate service storage/routing; not an SDK defect.',
  },
  'route-not-available': {
    category: 'API limitation: route not available',
    cause: 'Service did not recognize the request route for this endpoint/API version; not an SDK defect.',
  },
  'deployment-not-found': {
    category: 'Configuration: deployment not found',
    cause: 'Service reports that the Azure deployment was not found. Check the deployment mapping.',
  },
};
