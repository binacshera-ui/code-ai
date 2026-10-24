import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',ops=root+'/ops/fleet-capacity-20261024';
const source=path.dirname(await fs.realpath(root+'/dist'));
const manifest=JSON.parse(await fs.readFile(source+'/release-files.json','utf8'));
const before=JSON.parse(await fs.readFile(ops+'/windows-source.json','utf8'));
assert.equal(before.runningBinaries.length,1);
const binary=before.runningBinaries[0];assert.match(binary.version,/^codex-cli /);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stage=await fs.mkdtemp('/mnt/hdd/code-ai-builds/capacity-windows-20261024-');
for(const [name,sha]of Object.entries(manifest.files)){
 assert.equal(hash(await fs.readFile(source+'/'+name)),sha);
 await fs.mkdir(path.dirname(stage+'/'+name),{recursive:true});await fs.copyFile(source+'/'+name,stage+'/'+name);
}
const release=JSON.parse(await fs.readFile(stage+'/release.json','utf8'));
release.expectedCodexVersion=binary.version.slice('codex-cli '.length);
release.platform='win32';release.runtimeSourceRelease=source;
release.platformNote='Reuse the exact verified API bundle with the existing official Windows Codex binary; no second CLI installation.';
await fs.writeFile(stage+'/release.json',JSON.stringify(release,null,2)+'\n');
let runner=before.runnerText;
assert.ok(runner.includes('CODEX_BIN: pairing.codexBin,'));
runner=runner.replace('CODEX_BIN: pairing.codexBin,',"CODE_AI_HTTP_SINGLE_INGRESS: '1', CODEX_REMOTE_INCIDENT_SERVER_ID: pairing.id,\n  CODEX_INCIDENT_FAILURE_URL: 'https://app-codex.bina-cshera.co.il/api/codex/remote-incidents/' + pairing.id,\n  CODEX_INCIDENT_FAILURE_AUTH_TOKEN: pairing.token,\n  CODEX_BIN: pairing.codexBin,");
await fs.writeFile(stage+'/runner.mjs',runner);
execFileSync(process.execPath,['--check',stage+'/runner.mjs']);
for(const name of ['release.json','runner.mjs'])manifest.files[name]=hash(await fs.readFile(stage+'/'+name));
await fs.writeFile(stage+'/release-files.json',JSON.stringify(manifest,null,2)+'\n');
const archive=stage+'.zip';
execFileSync('zip',['-q',archive,'-@'],{cwd:stage,input:[...Object.keys(manifest.files),'release-files.json'].join('\n')+'\n',timeout:120000});
const report={source,stage,archive,sha256:hash(await fs.readFile(archive)),version:release.version,expectedCodexVersion:release.expectedCodexVersion,
 remoteCandidate:'C:/Users/showp/.code-ai/remote-agent/releases/'+release.version,
 binary,runnerHash:manifest.files['runner.mjs'],appSha256:manifest.files['dist/app.mjs'],archiveBytes:(await fs.stat(archive)).size};
await fs.writeFile(ops+'/windows-package.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
