import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const [buildId] = process.argv.slice(2);
assert.match(buildId, /^[a-f0-9-]{36}$/);
const staged = JSON.parse(await readFile('ops/immediate-release/staged-' + buildId + '.json', 'utf8'));
const hosts = { 'beam-10g': 'beam-10g', pci: 'code-ai-pci-host', 'ubuntu-gpu-lab': 'personal-ubuntu-ssh' };
for (const request of staged.targets.filter(request => hosts[request.id])) {
  const command = (request.id === 'pci' ? 'sudo -n ' : '') + request.nodeExecutable + ' '
    + request.candidate + '/install.mjs activate ' + request.candidate + '/deployment-request.json';
  const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', hosts[request.id], command],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 });
  const receipt = JSON.parse(output);
  assert.equal(receipt.id, request.id);
  assert.equal(receipt.installed, true);
  assert.equal(receipt.buildId, buildId);
  await writeFile('ops/immediate-release/receipt-' + request.id + '-' + buildId + '.json',
    JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(receipt));
}
