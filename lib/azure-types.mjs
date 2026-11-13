import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root } from './io.mjs';

export async function azureExtensionFields() {
  const file = join(root, 'node_modules', '@azure', 'openai', 'dist', 'esm', 'types', 'index.d.ts');
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const fields = [];
  function visit(node, scope = []) {
    if (ts.isModuleDeclaration(node)) {
      const next = ts.isStringLiteral(node.name) ? scope : [...scope, node.name.text];
      if (node.body) visit(node.body, next);
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          fields.push({ type: [...scope, node.name.text].join('.'), field: member.name.getText(source) });
        }
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  const module = source.statements.find((node) => ts.isModuleDeclaration(node) && node.name.text === 'openai/resources/index');
  if (!module) throw new Error('Azure extension module layout changed; inspect declarations before updating probes.');
  visit(module);
  if (!fields.length) throw new Error('No Azure extension fields discovered.');
  return fields;
}

export function compileAzureProbe(packageName, text, augmented = false) {
  if (!['openai', 'openai-current'].includes(packageName)) throw new Error('Unknown SDK package');
  const file = join(root, 'compat-probe.mts');
  const input = `${augmented ? 'import "@azure/openai/types";\n' : ''}${text}`;
  const options = {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, strict: true, noEmit: true,
    skipLibCheck: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    baseUrl: root,
    paths: {
      openai: [`node_modules/${packageName}/index.d.mts`],
      'openai/*': [`node_modules/${packageName}/*.d.mts`, `node_modules/${packageName}/*`],
    },
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (path) => resolve(path) === file ? input : originalRead(path);
  host.fileExists = (path) => resolve(path) === file || originalExists(path);
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    line: diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
}

export async function probeAzureTypes(packageName) {
  const fields = await azureExtensionFields();
  const text = fields.map(({ type, field }, index) =>
    `type Field${index} = import("openai/resources/index").${type}["${field}"];`).join('\n');
  const nativeErrors = compileAzureProbe(packageName, text);
  const extendedErrors = compileAzureProbe(packageName, text, true);
  const create = 'client.chat.completions.create({ model: "test", messages: [] })';
  const streamed = 'client.chat.completions.create({ model: "test", messages: [], stream: true })';
  const completion = 'client.completions.create({ model: "test", prompt: "test" })';
  const image = 'client.images.generate({ model: "test", prompt: "test" })';
  const receivers = {
    Completion: `await ${completion}`,
    CompletionChoice: `(await ${completion}).choices[0]`,
    ChatCompletion: `await ${create}`,
    ChatCompletionMessage: `(await ${create}).choices[0].message`,
    'ChatCompletion.Choice': `(await ${create}).choices[0]`,
    ImagesResponse: `await ${image}`,
    UploadPart: 'await client.uploads.parts.create("test", { data: new File(["test"], "test.txt") })',
  };
  const callSites = fields.map(({ type, field }, index) => {
    let body;
    if (type.startsWith('ChatCompletionCreateParams')) {
      body = `await client.chat.completions.create({ model: "test", messages: [], ${field}: [], stream: ${type.endsWith('NonStreaming') ? 'false' : 'true'} });`;
    } else if (type.startsWith('ChatCompletionChunk')) {
      const receiver = type.endsWith('.Delta') ? 'event.choices[0].delta' : type.endsWith('.Choice') ? 'event.choices[0]' : 'event';
      body = `for await (const event of await ${streamed}) { void ${receiver}.${field}; }`;
    } else {
      if (!receivers[type]) throw new Error('New Azure type requires an actual call-site probe.');
      body = `const result = ${receivers[type]}; void result.${field};`;
    }
    return `async function probe${index}(client: import("openai").AzureOpenAI) { ${body} }`;
  }).join('\n');
  const nativeCallErrors = compileAzureProbe(packageName, callSites);
  const extendedCallErrors = compileAzureProbe(packageName, callSites, true);
  for (const [errors, offset] of [[nativeErrors, 0], [extendedErrors, 1]]) {
    const unexpected = errors.filter((error) =>
      error.line === null || error.line <= offset || error.line > fields.length + offset ||
      ![2339, 2694].includes(error.code));
    if (unexpected.length) throw new Error(`Type probe infrastructure failed: ${JSON.stringify(unexpected)}`);
  }
  for (const [errors, offset] of [[nativeCallErrors, 0], [extendedCallErrors, 1]]) {
    if (errors.some((error) => error.line === null || error.line <= offset || error.line > fields.length + offset ||
      ![2339, 2353, 2551, 2769].includes(error.code))) throw new Error('Azure call-site probe infrastructure failed.');
  }
  return fields.map((field, index) => {
    const native = !nativeErrors.some((error) => error.line === index + 1);
    const withAzureTypes = !extendedErrors.some((error) => error.line === index + 2);
    return {
      ...field, native, withAzureTypes,
      classification: native ? 'native' : withAzureTypes ? 'azure-type-extension-required' : 'unresolved-type-gap',
      callSite: {
        native: !nativeCallErrors.some((error) => error.line === index + 1),
        withAzureTypes: !extendedCallErrors.some((error) => error.line === index + 2),
        reviewedGap: field.type === 'UploadPart' && field.field === 'azure_block_id',
      },
    };
  });
}
