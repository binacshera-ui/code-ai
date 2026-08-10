import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readSource(relativePath) {
  return readFile(path.join(APP_ROOT, relativePath), 'utf8');
}

async function listTypeScriptSources(directory) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await listTypeScriptSources(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      sources.push(entryPath);
    }
  }
  return sources;
}

test('server child processes never open a visible Windows console', async () => {
  const childProcessFunctions = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execFileAsync']);
  const failures = [];
  let inspectedCalls = 0;

  for (const sourcePath of await listTypeScriptSources(path.join(APP_ROOT, 'server'))) {
    const source = await readFile(sourcePath, 'utf8');
    const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && childProcessFunctions.has(node.expression.text)) {
        inspectedCalls += 1;
        const options = node.arguments.at(-1);
        const hidesWindow = options && ts.isObjectLiteralExpression(options)
          && options.properties.some((property) => ts.isPropertyAssignment(property)
            && property.name.getText(sourceFile) === 'windowsHide'
            && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
        if (!hidesWindow) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          failures.push(`${path.relative(APP_ROOT, sourcePath)}:${position.line + 1} ${node.expression.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  assert.ok(inspectedCalls >= 19, `Expected to inspect the production child-process calls, found ${inspectedCalls}`);
  assert.deepEqual(failures, [], `Visible Windows child processes remain:\n${failures.join('\n')}`);
});

test('the Windows agent and its tunnel are always hidden', async () => {
  const source = await readSource('scripts/personal-computer-agent.mjs');
  assert.match(source, /spawnSync\(['"]npm['"][\s\S]*?windowsHide:\s*true/);
  assert.match(source, /spawn\(process\.execPath[\s\S]*?windowsHide:\s*true/);
  assert.match(source, /tunnel\s*=\s*spawn\(['"]ssh['"][\s\S]*?windowsHide:\s*true/);
});
