import assert from 'node:assert/strict';
import { readFile, writeFile, cp, mkdir, symlink, chmod, realpath, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Mechanical staging of a verified immutable BEAM import. No live service
// changes, credential transfer, dependency installation, or queue mutation.
const [buildId, artifact] = process.argv.slice(2);
assert.match(buildId, /^[a-f0-9-]{36}$/);
assert.equal(artifact, '/mnt/hdd/code-ai-builds/immediate-release-imports/' + buildId + '/artifact/dist');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(artifact + '/release-files.json', 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
  assert.equal(hash(await readFile(artifact + '/' + file)), expected);
}
const common = { buildId, ownerAuthorizedInterruption: true,
  expectedServerSha256: manifest.files['dist/server.js'], expectedAppSha256: manifest.files['dist/app.mjs'] };
const suffix = '20261010-immediate-' + buildId;
const targets = [
  { id: 'beam-10g', host: 'beam-10g',
    baseline: '/opt/code-ai-releases/20261009-draft-unblock-d37ae9ce-e402-4955-b335-f2af6a5d0374',
    candidate: '/opt/code-ai-releases/' + suffix,
    expectedBaselineSha256: '4c83ae10e25641a53475312e8cf2e38d0396533bb892b8ce04810b48deaef9e9',
    nodeExecutable: '/opt/node-v24.18.0-linux-x64/bin/node',
    environmentFile: '/opt/code-ai-releases/20261002-drafts-panel-r1/.remote-agent.env' },
  { id: 'pci', host: 'code-ai-pci-host', sudo: true,
    baseline: '/opt/code-ai-releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/app-draft-unblock-d37ae9ce-e402-4955-b335-f2af6a5d0374',
    candidate: '/opt/code-ai-releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/app-' + suffix,
    expectedBaselineSha256: '4c83ae10e25641a53475312e8cf2e38d0396533bb892b8ce04810b48deaef9e9',
    nodeExecutable: '/srv/beam254/code-ai-native/releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/bin/node',
    environmentFile: '/var/lib/code-ai-pci/runtime.env' },
  { id: 'ubuntu-gpu-lab', host: 'personal-ubuntu-ssh',
    baseline: '/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/20261009-draft-unblock-d37ae9ce-e402-4955-b335-f2af6a5d0374',
    candidate: '/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/' + suffix,
    expectedBaselineSha256: '79d8cd2292b6d420720f0aa5e2976d3d82bea8e22865501ca5a6dbc081c8ed1f',
    nodeExecutable: '/home/refael/.local/lib/node-v24.21.0-linux-x64/bin/node',
    pairingFile: '/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/pairing.json' },
  { id: 'main', baseline: '/mnt/hdd/code-ai-builds/drafts-panel-live-20261002',
    candidate: '/mnt/hdd/code-ai-builds/immediate-live-' + buildId,
    expectedBaselineSha256: '240e9f7e6a5b14a8e0754134cb1b448e051e6580bab0ddafb751bf9a381b07c7',
    nodeExecutable: '/root/.nvm/versions/node/v24.12.0/bin/node',
    uploadBaselineModule: '/root/projects/code-ai/.deploy-releases/0b5f0a3-upload-api/dist/server.js',
    uploadBaselineSha256: '66f7722ef2a9eb12d49a511ddea35d8b055fd9b3a1e4b56703a869abbb271e2e' },
];
const archive = '/mnt/hdd/code-ai-builds/immediate-release-imports/' + buildId + '/public-release.tar';
execFileSync('tar', ['-cf', archive, '-C', artifact, '.'], { stdio: 'pipe' });
const archiveSha = hash(await readFile(archive));
for (const target of targets) {
  const { host, sudo, ...details } = target;
  const request = { ...common, ...details };
  if (host) {
    const remoteArchive = '/var/tmp/code-ai-immediate-' + buildId + '.tar';
    execFileSync('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', archive, host + ':' + remoteArchive],
      { stdio: 'pipe', timeout: 90_000 });
    const script = `const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
      const r=${JSON.stringify(request)},a=${JSON.stringify(remoteArchive)};
      const h=b=>crypto.createHash('sha256').update(b).digest('hex');
      if(h(fs.readFileSync(a))!==${JSON.stringify(archiveSha)})throw Error('archive_digest_mismatch');
      fs.mkdirSync(r.candidate,{mode:0o755});
      cp.execFileSync('tar',['-xf',a,'-C',r.candidate],{stdio:'pipe'});
      fs.chmodSync(r.candidate,0o755);
      fs.symlinkSync(fs.realpathSync(r.baseline+'/node_modules'),r.candidate+'/node_modules');
      if(r.id==='ubuntu-gpu-lab')fs.copyFileSync(r.baseline+'/runner.mjs',r.candidate+'/runner.mjs');
      fs.writeFileSync(r.candidate+'/deployment-request.json',JSON.stringify(r,null,2)+'\\n',{mode:0o600,flag:'wx'});
      const result=cp.execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.candidate+'/deployment-request.json'],{cwd:r.candidate,encoding:'utf8',stdio:'pipe',timeout:90000});
      process.stdout.write(result);`;
    const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
      (sudo ? 'sudo -n ' : '') + target.nodeExecutable + ' -'], { input: script, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 });
    console.log(output.trim());
  } else {
    await mkdir(request.candidate, { mode: 0o755 });
    await cp(artifact, request.candidate, { recursive: true });
    await chmod(request.candidate, 0o755);
    await symlink(await realpath('/root/projects/code-ai/node_modules'), request.candidate + '/node_modules');
    await writeFile(request.candidate + '/deployment-request.json', JSON.stringify(request, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(execFileSync(request.nodeExecutable, [request.candidate + '/install.mjs', 'preflight', request.candidate + '/deployment-request.json'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, cwd: request.candidate }).trim());
  }
}
await writeFile('ops/immediate-release/staged-' + buildId + '.json', JSON.stringify({ buildId, archiveSha256: archiveSha,
  manifestSha256: hash(await readFile(artifact + '/release-files.json')), targets: targets.map(({ host, sudo, ...r }) => ({ ...common, ...r })) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ allFourTargetsStaged: true, productionServicesChanged: false, buildId }));
