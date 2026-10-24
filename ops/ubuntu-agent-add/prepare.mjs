import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const project = '/root/projects/code-ai';
const buildId = '80c8c7bf-871c-4f7b-b1c5-67cce4e024a8';
const imported = '/mnt/hdd/code-ai-builds/chrome-profile-edit-imports';
const verified = JSON.parse(execFileSync('/usr/local/bin/bina-build', ['verify-import', buildId, '--import-root', imported], {encoding:'utf8'}));
if (!verified.ok || verified.buildId !== buildId) throw new Error('IMPORT_NOT_VERIFIED');
const previous = JSON.parse(await fs.readFile(project + '/ops/windows-agent-add/package-receipt.json', 'utf8'));
const archiveBytes = await fs.readFile(previous.archive);
if (crypto.createHash('sha256').update(archiveBytes).digest('hex') !== previous.sha256) throw new Error('DEPENDENCY_PACKAGE_HASH_MISMATCH');
const stage = await fs.mkdtemp('/mnt/hdd/code-ai-builds/ubuntu-gpu-lab-agent-');
// Reuse the qualified bundle and the already packaged runtime dependencies.
// No dependency installation, compilation, or change to an active release.
execFileSync('/usr/bin/unzip', ['-q', previous.archive, 'node_modules/*', '-d', stage], {stdio:'pipe'});
await fs.cp(path.join(verified.artifact, 'dist'), path.join(stage, 'dist'), {recursive:true});
await fs.copyFile(project + '/ops/ubuntu-agent-add/runner.mjs', stage + '/runner.mjs');
await fs.writeFile(stage + '/package.json', JSON.stringify({name:'code-ai-ubuntu-runtime', version:'2026.10.8', private:true, type:'module'}));
const assets = ['server/browser-mode', 'server/design-mode', 'server/ux-mode', 'server/phone-mode', 'server/personal-chrome',
  'skills/code-ai-conversation-search', 'skills/gemini-design-partner', 'skills/gemini-ux-partner'];
for (const asset of assets) await fs.cp(project + '/' + asset, stage + '/' + asset, {recursive:true});
await fs.access(stage + '/node_modules/node-pty/build/Release/pty.node');
const archive = stage + '.tar.gz';
execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, '.'], {stdio:'pipe'});
const receipt = {buildId, artifactTreeSha256:verified.artifactTreeSha256, stage, archive,
  bytes:(await fs.stat(archive)).size, sha256:crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex'),
  serverSha256:crypto.createHash('sha256').update(await fs.readFile(stage + '/dist/server.js')).digest('hex')};
await fs.writeFile(project + '/ops/ubuntu-agent-add/package-receipt.json', JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
