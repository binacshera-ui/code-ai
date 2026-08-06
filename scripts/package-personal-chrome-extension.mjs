#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(APP_ROOT, 'chrome-extension');

function usage() {
  console.log(`Usage: node scripts/package-personal-chrome-extension.mjs --output <directory> [--control-origin <origin>] [--force]

Creates a ready-to-load unpacked Chrome extension directory. The source package
stays environment-neutral; --control-origin configures the generated Side Panel.
`);
}

function parseArgs(argv) {
  let output = '';
  let controlOrigin = 'http://127.0.0.1:4000';
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') output = argv[++index] || '';
    else if (argument === '--control-origin') controlOrigin = argv[++index] || '';
    else if (argument === '--force') force = true;
    else if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!output) throw new Error('--output is required.');
  const parsedOrigin = new URL(controlOrigin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol)) throw new Error('--control-origin must use http or https.');
  if (parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error('--control-origin must be an origin only, without credentials, path, query, or fragment.');
  }
  return { output: path.resolve(output), controlOrigin: parsedOrigin.origin, force };
}

function assertSafeOutput(output) {
  const forbidden = new Set([
    path.parse(output).root,
    path.resolve(os.homedir()),
    APP_ROOT,
    SOURCE_ROOT,
  ]);
  if (forbidden.has(output) || output.length < path.parse(output).root.length + 5) {
    throw new Error(`Refusing unsafe output directory: ${output}`);
  }
}

async function main() {
  const { output, controlOrigin, force } = parseArgs(process.argv.slice(2));
  assertSafeOutput(output);
  if (force) await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: false });
  await cp(SOURCE_ROOT, output, { recursive: true, force: false, errorOnExist: true });

  const panelPath = path.join(output, 'panel.html');
  const panel = await readFile(panelPath, 'utf8');
  const marker = 'content="http://127.0.0.1:4000"';
  if (!panel.includes(marker)) throw new Error('Could not find the neutral control-origin marker in panel.html.');
  await writeFile(panelPath, panel.replace(marker, `content="${controlOrigin}"`), 'utf8');
  await writeFile(path.join(output, 'PACKAGED.txt'), [
    'CODE-AI Personal Chrome — unpacked extension package',
    `Preconfigured control origin: ${controlOrigin}`,
    `Packaged at: ${new Date().toISOString()}`,
    '',
    'Open chrome://extensions, enable Developer mode, choose Load unpacked,',
    'and select this directory. Keep the source repository as the source of truth.',
    '',
  ].join('\n'), 'utf8');
  console.log(JSON.stringify({ output, controlOrigin, loadUnpacked: true }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
