import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export function at(value, path) {
  if (!path) return value;
  let result = value;
  for (const part of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error(`Unsafe property path ${path}`);
    if (result === undefined || result === null) return undefined;
    result = result[part];
  }
  return result;
}

export async function materialize(value, context) {
  if (Array.isArray(value)) return Promise.all(value.map((item) => materialize(item, context)));
  if (!value || typeof value !== 'object') return value;
  const special = Object.keys(value).filter((key) => key.startsWith('$'));
  if (special.length) {
    if (special.length !== 1 || !['$env', '$ref', '$file', '$literal'].includes(special[0])) {
      throw new Error('Unknown or ambiguous fixture directive');
    }
    if ('$literal' in value) return value.$literal;
    if ('$env' in value) {
      const result = context.env[value.$env];
      if (!result) throw new Error(`Missing environment variable ${value.$env}`);
      return result;
    }
    if ('$ref' in value) {
      const result = at(context.results, value.$ref);
      if (result === undefined) throw new Error(`Missing scenario reference ${value.$ref}`);
      return result;
    }
    const path = resolve(context.fixtureDirectory, value.$file);
    const rel = relative(context.fixtureDirectory, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('Fixture file must be inside the fixture directory');
    }
    return context.toFile(await readFile(path), value.name ?? value.$file, value.type ? { type: value.type } : undefined);
  }
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsafe fixture key ${key}`);
    return [key, await materialize(item, context)];
  })));
}

export function assertResult(result, assertions) {
  for (const rule of assertions) {
    const value = at(result, rule.path);
    const message = `Assertion ${rule.op} failed at ${rule.path || '<root>'}`;
    try {
      switch (rule.op) {
        case 'exists': assert.notEqual(value, undefined, message); assert.notEqual(value, null, message); break;
        case 'equals': assert.deepEqual(value, rule.value, message); break;
        case 'type': assert.equal(Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value, rule.value, message); break;
        case 'nonEmpty': assert.ok((typeof value === 'string' || Array.isArray(value)) && value.length > 0, message); break;
        case 'includes': assert.ok((typeof value === 'string' || Array.isArray(value)) && value.includes(rule.value), message); break;
        case 'greaterThan': assert.ok(typeof value === 'number' && value > rule.value, message); break;
        case 'matches': assert.ok(typeof value === 'string' && new RegExp(rule.value).test(value), message); break;
        default: throw new Error(`Unknown assertion ${rule.op}`);
      }
    } catch (error) {
      error.assertionPath = rule.path;
      error.assertionOp = rule.op;
      throw error;
    }
  }
}

async function capture(data, mode, signal) {
  if (mode === 'text') {
    assert.ok(data instanceof Response, 'Expected binary/text Response');
    return data.text();
  }
  if (mode === 'bytes') {
    assert.ok(data instanceof Response, 'Expected binary Response');
    return { byteLength: (await data.arrayBuffer()).byteLength };
  }
  if (mode === 'stream') {
    assert.ok(data && typeof data[Symbol.asyncIterator] === 'function', 'Expected an SDK stream');
    const events = [];
    for await (const event of data) {
      signal.throwIfAborted();
      events.push(event);
      assert.ok(events.length <= 10_000, 'Stream exceeds event limit');
    }
    return {
      events, types: events.map((event) => event.type).filter(Boolean),
      text: events.map((event) => event.delta ?? '').filter((delta) => typeof delta === 'string').join(''),
    };
  }
  return data;
}

export async function executeScenario(client, entry, fixtures, options = {}) {
  const results = {};
  const errors = [];
  const context = {
    results, env: options.env ?? process.env,
    fixtureDirectory: options.fixtureDirectory,
    toFile: options.toFile,
  };
  async function runStep(step, cleanup = false) {
    const parts = step.method.split('.');
    let receiver = client;
    for (const part of parts.slice(0, -1)) {
      if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Unsafe SDK path');
      receiver = receiver?.[part];
    }
    const name = parts.at(-1);
    if (['__proto__', 'constructor', 'prototype'].includes(name) || typeof receiver?.[name] !== 'function') {
      throw new Error(`SDK method unavailable: ${step.method}`);
    }
    const args = await materialize(step.fixture ? fixtures[step.fixture].args : step.args, context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Live step timeout')), options.timeout ?? 120_000);
    let abortListener;
    try {
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const operation = (async () => {
        // Explicit request-options arity is necessary for methods with optional parameter objects.
        if (!Number.isInteger(step.optionsIndex) || step.optionsIndex < args.length) {
          throw new Error(`Set optionsIndex to the SDK request-options position for ${step.id}`);
        }
        while (args.length < step.optionsIndex) args.push(undefined);
        args.push({ signal: controller.signal, timeout: options.timeout ?? 120_000, maxRetries: 0 });
        const pending = receiver[name](...args);
        if (!pending || typeof pending.withResponse !== 'function') {
          throw new Error(`Expected APIPromise for ${step.method}; helper features need a custom test adapter.`);
        }
        const { data, response } = await pending.withResponse();
        assert.ok(response instanceof Response, 'Missing raw HTTP response');
        assert.ok(response.ok, `Unexpected HTTP status ${response.status}`);
        results[step.id] = await capture(data, step.capture ?? 'json', controller.signal);
        assertResult(results[step.id], step.assertions);
        options.onStep?.({ id: step.id, method: step.method, status: response.status, cleanup });
      })();
      await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timeout);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  }
  try {
    for (const step of entry.steps) {
      try {
        await runStep(step);
      } catch (error) {
        error.stepId = step.id;
        throw error;
      }
    }
  } catch (error) {
    errors.push(error);
  } finally {
    for (const step of entry.cleanup ?? []) {
      // Cleanup conditions depend on resource creation succeeding, not the full scenario passing.
      if (step.when && at(results, step.when) === undefined) continue;
      try {
        await runStep(step, true);
      } catch (error) {
        error.stepId = step.id;
        error.cleanup = true;
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, `${entry.id}: ${errors.map((error) => error.message).join('; ')}`);
  return results;
}
