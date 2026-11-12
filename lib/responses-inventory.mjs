import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions, root } from './io.mjs';

export const responsesPackages = ['openai', 'openai-current'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const modules = ['responses', 'input-items', 'input-tokens'];

export async function responsesInventory(packageName) {
  if (!responsesPackages.includes(packageName)) throw new Error('Unknown Responses SDK package.');
  const directory = join(root, 'node_modules', packageName);
  const version = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version;
  const files = modules.map((name) => join(directory, 'resources', 'responses', `${name}.d.mts`));
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [], noEmit: true,
  });
  const checker = program.getTypeChecker();
  const exports = new Map();
  const schema = [];
  const methods = [];
  const printer = ts.createPrinter({ removeComments: true });
  for (const [index, file] of files.entries()) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`Missing Responses declaration module: ${modules[index]}`);
    const symbol = checker.getSymbolAtLocation(source);
    for (const entry of checker.getExportsOfModule(symbol)) {
      exports.set(entry.name, { symbol: entry, module: modules[index] });
    }
    for (const node of source.statements) {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isModuleDeclaration(node)) {
        schema.push({
          name: `${modules[index]}.${node.name.text}`,
          hash: hash(printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, ' ')),
        });
      }
      if (ts.isClassDeclaration(node)) {
        for (const member of node.members.filter(ts.isMethodDeclaration)) {
          methods.push(`${modules[index] === 'responses' ? '' : `${modules[index] === 'input-items' ? 'inputItems' : 'inputTokens'}.`}${member.name.getText(source)}`);
        }
      }
      const sharedNames = new Set();
      function collectShared(node) {
        if (ts.isQualifiedName(node) && node.left.getText() === 'Shared') sharedNames.add(node.right.text);
        ts.forEachChild(node, collectShared);
      }
      for (const file of files) collectShared(program.getSourceFile(file));
      const shared = program.getSourceFile(join(directory, 'resources', 'shared.d.mts'));
      if (shared) {
        for (const node of shared.statements) {
          if (node.name && sharedNames.has(node.name.text)) schema.push({
            name: `shared.${node.name.text}`,
            hash: hash(printer.printNode(ts.EmitHint.Unspecified, node, shared).replace(/\s+/g, ' ')),
          });
        }
      }
    }
  }
  const typeOf = (name) => {
    const entry = exports.get(name);
    if (!entry) throw new Error(`Responses declaration missing: ${name}`);
    return checker.getDeclaredTypeOfSymbol(entry.symbol);
  };
  const propertyType = (type, property) => checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations[0]);
  function sample(type, seen = new Set()) {
    if (type.flags & ts.TypeFlags.StringLiteral) return type.value;
    if (type.flags & ts.TypeFlags.NumberLiteral) return type.value;
    if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName === 'true';
    if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return null;
    if (type.isUnion()) {
      const candidates = type.types.filter((item) => !(item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
      return sample(candidates[0] ?? type.types[0], seen);
    }
    if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) return 'compatibility';
    if (type.flags & ts.TypeFlags.Number) return 1;
    if (type.flags & ts.TypeFlags.Boolean) return false;
    if (type.isIntersection() && type.types.some((item) => item.flags & ts.TypeFlags.String)) return 'compatibility';
    if (checker.isTupleType(type)) return checker.getTypeArguments(type).map((item) => sample(item, seen));
    if (checker.isArrayType(type)) return [];
    if (seen.has(type) || seen.size > 20) throw new Error('Recursive fixture needs an authored sample.');
    const next = new Set([...seen, type]);
    return Object.fromEntries(type.getProperties()
      .filter((property) => !(property.flags & ts.SymbolFlags.Optional) || property.name === 'type')
      .map((property) => [property.name, sample(propertyType(type, property), next)]));
  }
  const fixtures = [];
  function fields(name, kind) {
    const type = typeOf(name);
    for (const property of type.getProperties()) {
      const value = propertyType(type, property);
      fixtures.push({
        id: `${kind}:${property.name}`, kind, field: property.name,
        module: exports.get(name).module, type: `${name}[${JSON.stringify(property.name)}]`,
        value: property.name === 'include' && checker.isArrayType(checker.getNonNullableType(value))
          ? [sample(checker.getNonNullableType(value).getNumberIndexType())] : sample(value),
      });
    }
  }
  fields('ResponseCreateParamsBase', 'create');
  fields('ResponseRetrieveParamsBase', 'retrieve');
  fields('ResponseCompactParams', 'compact');
  fields('InputTokenCountParams', 'input-tokens');
  fields('InputItemListParams', 'input-items');
  fields('Response', 'response');
  function variantsOf(type, kind, name) {
    const entries = [];
    const members = new Map();
    for (const member of type.isUnion() ? type.types : [type]) {
      const discriminator = member.getProperty('type');
      const value = sample(member);
      const discriminant = discriminator && propertyType(member, discriminator);
      const labels = discriminant
        ? (discriminant.isUnion() ? discriminant.types : [discriminant])
          .filter((item) => item.flags & ts.TypeFlags.StringLiteral).map((item) => item.value)
        : typeof value === 'string' ? [value] : [];
      if (!labels.length) throw new Error(`Cannot identify ${name} variant.`);
      for (const label of labels) {
        const entry = {
          id: `${kind}:${label}`, kind, module: 'responses', type: name,
          value: discriminator ? { ...value, type: label } : value,
          variant: member.aliasSymbol?.name ?? member.symbol?.name ?? label,
        };
        entries.push(entry);
        members.set(entry, member);
      }
    }
    const counts = new Map();
    for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    for (const entry of entries) {
      if (counts.get(entry.id) > 1) entry.id += `:${entry.variant}`;
      fixtures.push(entry);
      for (const property of members.get(entry).getProperties()) {
        if (property.name === 'type' || typeof entry.value !== 'object') continue;
        fixtures.push({
          ...entry, id: `${kind}-field:${entry.id.slice(kind.length + 1)}.${property.name}`, field: property.name,
          value: { ...entry.value, [property.name]: sample(propertyType(members.get(entry), property)) },
        });
      }
    }
  }
  const variants = (name, kind) => variantsOf(typeOf(name), kind, name);
  variants('Tool', 'tool');
  variants('ResponseInputItem', 'input');
  variants('ResponseOutputItem', 'output');
  variants('ResponseStreamEvent', 'event');
  variants('ResponseInputContent', 'content');
  const outputContent = typeOf('ResponseOutputMessage').getProperty('content');
  variantsOf(propertyType(typeOf('ResponseOutputMessage'), outputContent).getNumberIndexType(),
    'output-content', 'ResponseOutputMessage["content"][number]');
  variants('ResponseFormatTextConfig', 'format');
  for (const name of ['ResponseIncludable', 'ResponseStatus', 'ToolChoiceOptions']) {
    const kind = { ResponseIncludable: 'include', ResponseStatus: 'status', ToolChoiceOptions: 'tool-choice' }[name];
    for (const item of typeOf(name).types) {
      const value = sample(item);
      fixtures.push({ id: `${kind}:${value}`, kind, module: 'responses', type: name, value });
    }
  }
  const choice = typeOf('ResponseCreateParamsBase').getProperty('tool_choice');
  for (const item of propertyType(typeOf('ResponseCreateParamsBase'), choice).types) {
    const discriminator = item.getProperty('type');
    if (!discriminator) continue;
    const value = sample(item);
    fixtures.push({ id: `tool-choice:${value.type}`, kind: 'tool-choice', module: 'responses', type: 'ResponseCreateParamsBase["tool_choice"]', value });
  }
  for (const method of [...new Set(methods)]) fixtures.push({ id: `method:${method}`, kind: 'method', method });
  const controlNames = ['reasoning', 'text', 'context_management', 'moderation', 'stream_options', 'prompt_cache_options', 'access_programs', 'prompt'];
  for (const control of controlNames) {
    const property = typeOf('ResponseCreateParamsBase').getProperty(control);
    if (!property) continue;
    const type = checker.getNonNullableType(propertyType(typeOf('ResponseCreateParamsBase'), property));
    const element = type.getNumberIndexType();
    const objectType = element ?? type;
    for (const member of objectType.getProperties()) {
      const fieldType = checker.getNonNullableType(propertyType(objectType, member));
      const values = fieldType.isUnion() && fieldType.types.every((item) => item.flags & ts.TypeFlags.StringLiteral)
        ? fieldType.types.map((item) => sample(item)) : [sample(fieldType)];
      for (const value of values) {
        const object = { ...sample(objectType), [member.name]: value };
        fixtures.push({
          id: `control:${control}.${member.name}:${typeof value === 'string' ? value : 'value'}`,
          kind: 'control', module: 'responses', type: 'ResponseCreateParamsNonStreaming',
          value: { model: 'compat-responses-deployment', input: 'compatibility', [control]: element ? [object] : object },
        });
      }
    }
  }
  const unique = new Map();
  for (const fixture of fixtures) {
    if (unique.has(fixture.id) && JSON.stringify(unique.get(fixture.id)) !== JSON.stringify(fixture)) {
      throw new Error(`Ambiguous Responses fixture: ${fixture.id}`);
    }
    unique.set(fixture.id, fixture);
  }
  return { version, package: packageName, schema, fixtures: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function responsesCoverage(inventory, catalog) {
  const reviewedSchemas = new Map();
  const cases = new Map();
  for (const snapshot of catalog.snapshots) {
    for (const declaration of snapshot.schema) {
      if (declaration.reviewed === false) continue;
      if (!reviewedSchemas.has(declaration.name)) reviewedSchemas.set(declaration.name, new Set());
      reviewedSchemas.get(declaration.name).add(declaration.hash);
    }
    for (const entry of snapshot.fixtures) {
      if (entry.ready === true) cases.set(entry.id, entry);
    }
  }
  const preferred = new Map(catalog.snapshots.filter((snapshot) => compareVersions(snapshot.version, inventory.version) <= 0)
    .flatMap((snapshot) => snapshot.fixtures.filter((entry) => entry.ready === true)).map((entry) => [entry.id, entry]));
  const baseline = catalog.snapshots[0].fixtures.map((entry) => entry.id);
  const available = new Set(inventory.fixtures.map((entry) => entry.id));
  const removedBaseline = baseline.filter((id) => !available.has(id));
  const knownRemovals = new Set(catalog.snapshots.filter((snapshot) => compareVersions(snapshot.version, inventory.version) <= 0)
    .flatMap((snapshot) => snapshot.removedBaseline?.filter((entry) => entry.reviewed).map((entry) => entry.id) ?? []));
  return {
    version: inventory.version,
    missing: inventory.fixtures.filter((entry) => !cases.has(entry.id)).map((entry) => entry.id),
    unreviewedSchemas: inventory.schema.filter((entry) => !reviewedSchemas.get(entry.name)?.has(entry.hash)).map((entry) => entry.name),
    removedBaseline,
    unreviewedRemovals: removedBaseline.filter((id) => !knownRemovals.has(id)),
    fixtures: inventory.fixtures.map((entry) => ({ ...entry, ...(preferred.get(entry.id) ?? cases.get(entry.id)), ready: cases.has(entry.id) })),
  };
}
