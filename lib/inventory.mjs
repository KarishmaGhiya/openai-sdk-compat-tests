import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export const digest = (text) => createHash('sha256').update(text).digest('hex');

function canonical(node, source) {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, ' ').trim();
}

export function parseMethods(markdown) {
  const methods = new Map();
  const regex = /<code title="([^"]+)">client\.([\w.]+)\.<a href="\.\/([^"]+)">(\w+)<\/a>(.*?)<\/code>/g;
  for (const match of markdown.matchAll(regex)) {
    const id = `${match[2]}.${match[4]}`;
    const value = { id, endpoint: match[1], source: match[3], signature: match[5].replace(/&gt;/g, '>') };
    if (methods.has(id) && methods.get(id).endpoint !== value.endpoint) {
      throw new Error(`Conflicting documented method ${id}`);
    }
    methods.set(id, value);
  }
  const documented = [...markdown.matchAll(/<code title="[^"]+">client\./g)].length;
  if (methods.size === 0 || documented !== [...markdown.matchAll(regex)].length) {
    throw new Error('api.md format changed; endpoint inventory would be incomplete.');
  }
  return [...methods.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resourceMethods(program, clientFile, directory, documented = []) {
  const source = program.getSourceFile(clientFile);
  const declaration = source?.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'OpenAI');
  if (!declaration) throw new Error('Cannot find OpenAI client class');
  const checker = program.getTypeChecker();
  const documentedById = new Map(documented.map((method) => [method.id, method]));
  const result = [];
  function responseAssertions(method) {
    const signature = checker.getSignatureFromDeclaration(method);
    const returned = checker.getReturnTypeOfSignature(signature);
    const arguments_ = returned.typeArguments ?? [];
    const data = arguments_[0];
    if (!data) return { assertions: [{ path: '', op: 'exists' }] };
    if (data.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
      return { assertions: [{ path: '', op: 'type', value: 'null' }] };
    }
    if (data.symbol?.name === 'Response') {
      const binary = data.symbol.declarations?.some((node) => node.getSourceFile().fileName.endsWith('lib.dom.d.ts'));
      if (binary) return { capture: 'bytes', assertions: [{ path: 'byteLength', op: 'greaterThan', value: 0 }] };
    }
    if (data.isUnion()) return { assertions: [{ path: '', op: 'exists' }] };
    const assertions = [];
    for (const symbol of checker.getPropertiesOfType(data)) {
      if (symbol.flags & ts.SymbolFlags.Optional || symbol.name.startsWith('_')) continue;
      const property = symbol.declarations?.find((node) => ts.isPropertySignature(node) || ts.isPropertyDeclaration(node));
      if (!property || property.modifiers?.some((node) =>
        node.kind === ts.SyntaxKind.PrivateKeyword || node.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
      const type = checker.getTypeOfSymbolAtLocation(symbol, property);
      const path = symbol.name;
      if (type.flags & ts.TypeFlags.StringLiteral) assertions.push({ path, op: 'equals', value: type.value });
      else if (type.flags & ts.TypeFlags.NumberLiteral) assertions.push({ path, op: 'equals', value: type.value });
      else if (type.flags & ts.TypeFlags.String) assertions.push({ path, op: 'type', value: 'string' });
      else if (type.flags & ts.TypeFlags.Number) assertions.push({ path, op: 'type', value: 'number' });
      else if (type.flags & ts.TypeFlags.BooleanLike) assertions.push({ path, op: 'type', value: 'boolean' });
      else if (checker.isArrayType(type) || checker.isTupleType(type)) assertions.push({ path, op: 'type', value: 'array' });
      else if (!type.isUnion()) assertions.push({ path, op: 'exists' });
    }
    return { assertions: assertions.length ? assertions : [{ path: '', op: 'exists' }] };
  }
  function walk(type, prefix, ancestors) {
    if (ancestors.has(type)) throw new Error(`Cyclic resource graph at ${prefix}`);
    const next = new Set([...ancestors, type]);
    for (const symbol of checker.getPropertiesOfType(type)) {
      const name = symbol.name;
      if (name.startsWith('_')) continue;
      const members = symbol.declarations ?? [];
      const property = members.find((node) => ts.isPropertyDeclaration(node) && node.initializer && ts.isNewExpression(node.initializer));
      if (property) {
        walk(checker.getTypeOfSymbolAtLocation(symbol, property), `${prefix}${name}.`, next);
        continue;
      }
      const method = members.find((node) => ts.isMethodDeclaration(node) && node.body);
      if (!method || method.modifiers?.some((node) => node.kind === ts.SyntaxKind.PrivateKeyword || node.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
      const calls = [];
      function find(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ['get', 'post', 'put', 'patch', 'delete', 'getAPIList'].includes(node.expression.name.text) &&
          node.expression.expression.getText(method.getSourceFile()) === 'this._client') calls.push(node);
        ts.forEachChild(node, find);
      }
      find(method.body);
      const documentedMethod = documentedById.get(`${prefix}${name}`);
      if (!calls.length && !documentedMethod) continue;
      if (!calls.length) {
        const optionsIndex = method.parameters.findIndex((parameter) => parameter.name.getText(method.getSourceFile()) === 'options');
        if (optionsIndex < 0) throw new Error(`Unknown request-options position ${prefix}${name}`);
        result.push({
          ...documentedMethod, optionsIndex, ...responseAssertions(method),
          signature: `(${method.parameters.slice(0, optionsIndex).map((parameter) => canonical(parameter, method.getSourceFile())).join(', ')}) -> ${method.type ? canonical(method.type, method.getSourceFile()) : 'unknown'}`,
        });
        continue;
      }
      if (calls.length !== 1 || !calls[0].arguments.length) throw new Error(`Ambiguous endpoint implementation ${prefix}${name}`);
      const optionsIndex = method.parameters.findIndex((parameter) => parameter.name.getText(method.getSourceFile()) === 'options');
      if (optionsIndex < 0) throw new Error(`Unknown request-options position ${prefix}${name}`);
      const call = calls[0];
      const verb = call.expression.name.text === 'getAPIList' ? 'get' : call.expression.name.text;
      const endpoint = canonical(call.arguments[0], method.getSourceFile())
        .replace(/^path\s*`|`$/g, '').replace(/^['"]|['"]$/g, '')
        .replace(/\$\{([^}]+)\}/g, '{$1}');
      result.push({
        id: `${prefix}${name}`, source: relative(directory, method.getSourceFile().fileName).replaceAll('\\', '/'),
        endpoint: `${verb} ${endpoint}`, optionsIndex,
        ...responseAssertions(method),
        signature: `(${method.parameters.slice(0, optionsIndex).map((parameter) => canonical(parameter, method.getSourceFile())).join(', ')}) -> ${method.type ? canonical(method.type, method.getSourceFile()) : 'unknown'}`,
      });
    }
  }
  walk(checker.getTypeAtLocation(declaration), '', new Set());
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseSurface(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
  const surface = {};
  function visit(node, scope = '') {
    if (ts.isModuleDeclaration(node) && node.body) {
      if (!scope && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
      visit(node.body, `${scope}${node.name.getText(source)}.`);
      return;
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
      if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
      const name = `${scope}${node.name.text}`;
      if (ts.isTypeAliasDeclaration(node)) {
        surface[`${file}#${name}`] = digest(canonical(node.type, source));
      } else {
        for (const member of node.members) {
          if (!member.name) continue;
          const key = `${file}#${name}.${member.name.getText(source)}`;
          surface[key] = digest(canonical(member, source));
        }
        if (node.heritageClauses) {
          surface[`${file}#${name}.$extends`] = digest(node.heritageClauses.map((n) => canonical(n, source)).join(' '));
        }
      }
      return;
    }
    // Include public helper/class signatures, but not method bodies or private internals.
    if (ts.isClassDeclaration(node) && node.name) {
      if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
      for (const member of node.members) {
        if (!member.name || member.modifiers?.some((m) =>
          m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
        const name = member.name.getText(source);
        if (name.startsWith('_') || ts.isPrivateIdentifier(member.name)) continue;
        const signature = ts.isMethodDeclaration(member)
          ? `${member.typeParameters?.map((p) => canonical(p, source)).join(',') ?? ''}(${member.parameters.map((p) => canonical(p, source)).join(',')})${member.type ? canonical(member.type, source) : ''}`
          : canonical(member, source);
        const key = `${file}#${scope}${node.name.text}.${name}`;
        // Overloads are part of the same public method.
        surface[key] = digest(`${surface[key] ?? ''}|${signature}`);
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const signature = `${node.typeParameters?.map((p) => canonical(p, source)).join(',') ?? ''}(${node.parameters.map((p) => canonical(p, source)).join(',')})${node.type ? canonical(node.type, source) : ''}`;
      const key = `${file}#${scope}${node.name.text}`;
      surface[key] = digest(`${surface[key] ?? ''}|${signature}`);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(source);
  return surface;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat().sort();
}

export function changelogFeatures(markdown, version) {
  markdown = markdown.replaceAll('\r\n', '\n');
  const escaped = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^## (?:\\[${escaped}\\]|${escaped}(?=\\s))[^\\n]*`, 'm').exec(markdown);
  if (!heading) throw new Error(`Missing changelog section for ${version}`);
  const start = heading.index;
  const next = markdown.indexOf('\n## ', start + heading[0].length);
  const section = markdown.slice(start, next < 0 ? undefined : next);
  const features = section.split('### Features\n')[1]?.split(/\n### /)[0] ?? '';
  return features.split('\n').filter((line) => /^[*-] /.test(line)).map((line) => ({
    id: `changelog:${version}:${digest(line.replace(/\s+\(\[[\s\S]*$/, '')).slice(0, 16)}`,
    description: line.replace(/^[*-] /, '').replace(/\s+\(\[[\s\S]*$/, ''),
  }));
}

export async function inventory(directory, version) {
  const documented = parseMethods(await readFile(join(directory, 'api.md'), 'utf8'));
  const clientFile = resolve(directory, 'src', 'client.ts');
  const program = ts.createProgram([clientFile], {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext, skipLibCheck: true, noEmit: true,
  });
  const methods = resourceMethods(program, clientFile, directory, documented);
  const byId = new Map(methods.map((method) => [method.id, method]));
  for (const method of documented) {
    const actual = byId.get(method.id);
    if (!actual) throw new Error(`Documented endpoint was not reachable from client: ${method.id}`);
    actual.documentedEndpoint = method.endpoint;
    actual.documentedSignature = method.signature;
  }
  const surface = {};
  for (const folder of ['resources', 'lib', 'helpers']) {
    for (const path of await sourceFiles(join(directory, 'src', folder))) {
      Object.assign(surface, parseSurface(await readFile(path, 'utf8'), relative(directory, path).replaceAll('\\', '/')));
    }
  }
  return { version, methods, surface, features: changelogFeatures(await readFile(join(directory, 'CHANGELOG.md'), 'utf8'), version) };
}

export function diffSurface(previous, current) {
  const before = new Map(previous.methods.map((method) => [method.id, method]));
  const after = new Map(current.methods.map((method) => [method.id, method]));
  const addedMethods = current.methods.filter((method) => !before.has(method.id));
  const removedMethods = previous.methods.filter((method) => !after.has(method.id));
  const changedMethods = current.methods.filter((method) => before.has(method.id) &&
    JSON.stringify(before.get(method.id)) !== JSON.stringify(method));
  const changedSurface = Object.entries(current.surface)
    .filter(([key, hash]) => previous.surface[key] !== hash)
    .map(([key, hash]) => ({ key, hash, change: key in previous.surface ? 'changed' : 'added' }));
  const removedSurface = Object.keys(previous.surface).filter((key) => !(key in current.surface));
  return { addedMethods, removedMethods, changedMethods, changedSurface, removedSurface };
}
