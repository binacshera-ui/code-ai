import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = '/root/projects/code-ai';
const candidate = await mkdtemp('/mnt/hdd/code-ai-builds/focus-notifications-20261020-');
const paths = ['client', 'server', 'shared', 'scripts', 'chrome-extension', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.ts'];
const files = [];
async function capture(relative) {
  const input = path.join(source, relative);
  const stat = await import('node:fs/promises').then(fs => fs.lstat(input));
  if (stat.isDirectory()) {
    for (const name of (await readdir(input)).sort()) await capture(path.join(relative, name));
  } else if (stat.isFile()) files.push([relative, createHash('sha256').update(await readFile(input)).digest('hex')]);
  else throw Error(`Unexpected source entry: ${relative}`);
}
for (const relative of paths) {
  await capture(relative);
  await cp(path.join(source, relative), path.join(candidate, relative), { recursive: true });
}
const sourceSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
await symlink(path.join(source, 'node_modules'), path.join(candidate, 'node_modules'));
const identity = { format: 'code-ai-focus-notifications-qualification', version: 1, candidate, sourceSha256,
  scope: 'Germany main web only', buildHost: 'web',
  authority: 'User scope: commands, deployment and required repairs only on the main Germany server; no BEAM/other hosts.',
  baseRuntime: path.join(await realpath(path.join(source, 'dist')), 'server.js'),
  productionEffects: false, built: false, files };
await writeFile(path.join(candidate, 'build-identity.json'), JSON.stringify(identity, null, 2));
console.log(JSON.stringify({ candidate, sourceSha256 }));
execFileSync('npm', ['run', 'build'], { cwd: candidate, stdio: 'inherit',
  env: { ...process.env, TMPDIR: candidate, NODE_OPTIONS: '--max-old-space-size=6144' } });
identity.built = true;
identity.serverSha256 = createHash('sha256').update(await readFile(path.join(candidate, 'dist/server.js'))).digest('hex');
await writeFile(path.join(candidate, 'build-identity.json'), JSON.stringify(identity, null, 2));
console.log(JSON.stringify({ candidate, built: true, sourceSha256, serverSha256: identity.serverSha256 }));
