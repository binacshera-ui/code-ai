import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const project = '/root/projects/code-ai';
const artifact = '/mnt/hdd/code-ai-builds/chrome-profile-edit-imports/80c8c7bf-871c-4f7b-b1c5-67cce4e024a8/artifact';
const stage = await fs.mkdtemp('/mnt/hdd/code-ai-builds/windows-new-agent-');
await fs.cp(path.join(artifact, 'dist'), path.join(stage, 'dist'), { recursive: true });
await fs.copyFile(path.join(project, 'ops/windows-agent-add/runner.mjs'), path.join(stage, 'runner.mjs'));
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'code-ai-windows-agent', version: '2026.10.8', private: true, type: 'module' }));
const copied = new Set();
async function copyPackage(name, owner = path.join(project, 'package.json')) {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error('INVALID_DEPENDENCY_NAME');
  const require = createRequire(owner);
  let source;
  try { source = path.dirname(require.resolve(name + '/package.json')); }
  catch {
    source = path.dirname(require.resolve(name));
    while (JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
      if (path.dirname(source) === source) throw new Error('DEPENDENCY_PACKAGE_NOT_FOUND');
      source = path.dirname(source);
    }
  }
  if (!source.startsWith(path.join(project, 'node_modules') + '/')) throw new Error('DEPENDENCY_OUTSIDE_RUNTIME');
  if (copied.has(source)) return;
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  copied.add(source);
  await fs.cp(source, path.join(stage, path.relative(project, source)), { recursive: true, dereference: true });
  for (const dep of Object.keys(pkg.dependencies || {})) await copyPackage(dep, path.join(source, 'package.json'));
}
for (const dep of ['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws']) await copyPackage(dep);
await fs.access(path.join(stage, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node'));
await fs.access(path.join(stage, 'node_modules/node-pty/third_party/conpty'));
const archive = stage + '.zip';
execFileSync('zip', ['-q','-r',archive,'.'], { cwd: stage, stdio: 'pipe' });
const receipt = { stage, archive, sha256: crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex'),
  bytes: (await fs.stat(archive)).size, dependencyPackages: copied.size, buildId: '80c8c7bf-871c-4f7b-b1c5-67cce4e024a8' };
await fs.writeFile(path.join(project, 'ops/windows-agent-add/package-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
