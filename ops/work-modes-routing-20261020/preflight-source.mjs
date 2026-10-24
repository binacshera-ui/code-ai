import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require = createRequire('/root/projects/code-ai/package.json');
const ts = require('typescript');
const ops = '/root/projects/code-ai/ops/work-modes-routing-20261020';
const capture = JSON.parse(await fs.readFile(ops + '/capture.json', 'utf8'));
const root = capture.source;
const entries = ['server/index.ts', 'scripts/codex-shared-stdio.mjs',
  'scripts/copy-personal-chrome-runtime.mjs', 'scripts/verify-runtime-programs.mjs',
  'scripts/codex-work-mode.mjs', 'server/incidentRemoteGateway.test.ts',
  'server/incidentRemoteWake.test.ts', 'server/incidentDecisionCenter.test.ts',
  'server/codexRationalMode.test.ts', 'server/codexRuntimePrograms.test.mjs', 'server/codexWorkModeRoutes.test.ts'];
const visited = new Set(), missing = [], diagnostics = [];
async function resolve(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  assert.ok(base.startsWith(root + '/'), 'Import escapes capture');
  const candidates = [base];
  if (/\.js$/.test(base)) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  if (/\.mjs$/.test(base)) candidates.push(base.slice(0, -4) + '.mts');
  if (!path.extname(base)) candidates.push(...['.ts','.tsx','.js','.mjs','/index.ts','/index.js'].map(x => base + x));
  for (const file of candidates) {
    if (await fs.stat(file).then(s => s.isFile()).catch(() => false)) return file;
  }
  missing.push({from: path.relative(root, from), specifier});
}
async function visit(file) {
  if (visited.has(file)) return;
  visited.add(file);
  if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) return;
  const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const d of source.parseDiagnostics) diagnostics.push({file: path.relative(root,file), message: ts.flattenDiagnosticMessageText(d.messageText, '\n')});
  const specs = [];
  function scan(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) specs.push(node.arguments[0].text);
    ts.forEachChild(node, scan);
  }
  scan(source);
  for (const specifier of specs.filter(s => s.startsWith('.'))) {
    const target = await resolve(file, specifier);
    if (target) await visit(target);
  }
}
for (const entry of entries) await visit(root + '/' + entry);
for (const dir of ['personal-chrome','browser-mode','phone-mode','design-mode','ux-mode','codex-shared-modes']) assert.ok((await fs.stat(root+'/server/'+dir)).isDirectory());
const runtime = await import(pathToFileURL(root + '/server/codexRuntimePrograms.mjs'));
for (const [name, relative] of Object.entries(runtime.codexRuntimePrograms)) {
  if (name === 'sharedStdio') continue; // generated bundle, source entry is checked above
  await fs.access(path.resolve(root + '/server', relative));
}
const pkg = JSON.parse(await fs.readFile(root + '/package.json', 'utf8'));
const lock = await fs.readFile(root + '/pnpm-lock.yaml', 'utf8');
const importer = lock.split('importers:\n')[1]?.split('\npackages:')[0];
assert.ok(importer, 'Missing frozen pnpm importer');
for (const group of ['dependencies', 'devDependencies']) {
  const section = importer.split('    '+group+':\n')[1]?.split(/\n    \w/)[0] || '';
  for (const [name, version] of Object.entries(pkg[group] || {})) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = section.match(new RegExp('      [\x27\"]?'+escaped+'[\x27\"]?:\\n        specifier: ([^\\n]+)'));
    assert.equal(match?.[1]?.replace(/^['\"]|['\"]$/g,''), version, 'Frozen importer mismatch: '+name);
  }
}
const receipt = {source: root, sourceSha256: capture.sourceSha256, checkedAt: new Date().toISOString(), entries,
  parsedFiles: visited.size, runtimePrograms: Object.keys(runtime.codexRuntimePrograms).length,
  frozenDependenciesMatch: true, missing, diagnostics, passed: !missing.length && !diagnostics.length};
await fs.writeFile(ops + '/source-preflight.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
assert.equal(receipt.passed, true, 'Source input closure failed');
