// First installation only. Never upgrades, restarts or replaces an existing service.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const input=[];
for await (const chunk of process.stdin) input.push(chunk);
const request=JSON.parse(Buffer.concat(input).toString('utf8'));
assert.match(request.buildId,/^[a-f0-9-]{36}$/);
const release=`/opt/code-ai-releases/pci-${request.buildId}`;
const app=release+'/app';
const storage='/var/lib/code-ai-pci';
const envPath=storage+'/runtime.env';
const unit='/etc/systemd/system/code-ai-remote-pci.service';
assert.equal(process.getuid(),0);
for(const existing of [unit,envPath]) {
  assert.equal(await stat(existing).then(()=>true,()=>false),false,'Existing installation requires a separate update plan');
}
const identity=JSON.parse(await readFile(release+'/runtime-identity.json','utf8'));
assert.equal(identity.codexVersion,'0.160.1');
const run=(command,args)=>execFileSync(command,args,{stdio:'pipe',timeout:30000,encoding:'utf8'});
assert.equal(run(release+'/codex-vendor/bin/codex',['--version']).trim(),'codex-cli 0.160.1');
run(release+'/bin/node',['-e',`require(${JSON.stringify(app+'/node_modules/node-pty')})`]);
for(const dir of [storage,storage+'/uploads',storage+'/queue',storage+'/logs','/home/admin/.codex','/home/admin/.codex/sessions','/srv/projects']) {
  await mkdir(dir,{recursive:true,mode:0o750});
  run('chown',['admin:admin',dir]);
}
const environment={
  NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4010',HOME:'/home/admin',
  CODEX_APP_ROOT:app,CODEX_STORAGE_ROOT:storage,CODEX_UPLOAD_ROOT:storage+'/uploads',
  CODEX_QUEUE_ROOT:storage+'/queue',CODEX_LOG_ROOT:storage+'/logs',
  CODEX_OPEN_ACCESS:'false',CODEX_ALLOW_ANY_PATHS:'true',CODEX_CLI_AUTO_UPDATE:'false',
  CODEX_BIN:release+'/codex-vendor/bin/codex',
  CODEX_REMOTE_AGENT_TOKEN:request.remoteToken,CODEX_DEVICE_ADMIN_PASSWORD:request.devicePassword,
  SESSION_SECRET:request.sessionSecret,CODEX_SERVER_ID:'pci',CODEX_SERVER_LABEL:'PCI — ארה״ב',
  CODEX_PROFILES_JSON_BASE64:Buffer.from(JSON.stringify([{id:'pci-admin',label:'Admin',provider:'codex',codexHome:'/home/admin/.codex',workspaceCwd:'/srv/projects',defaultProfile:true}])).toString('base64'),
  ...request.notifications,
};
for(const name of ['CODEX_REMOTE_AGENT_TOKEN','CODEX_DEVICE_ADMIN_PASSWORD','SESSION_SECRET']) assert.ok(environment[name].length>=32);
for(const [name,value] of Object.entries(environment)) {assert.match(name,/^[A-Z][A-Z0-9_]*$/);assert.ok(!/[\r\n\0]/.test(value));}
await writeFile(envPath,Object.entries(environment).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
run('chown',['admin:admin',envPath]);
await writeFile(unit,`[Unit]
Description=Code AI isolated PCI remote agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
Group=admin
WorkingDirectory=${app}
ExecStart=${release}/bin/node --env-file=${envPath} ${app}/dist/server.js
Environment=PATH=${release}/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=60
UMask=0077
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`,{mode:0o644,flag:'wx'});
run('systemd-analyze',['verify',unit]);
run('systemctl',['daemon-reload']);
run('systemctl',['enable','--now','code-ai-remote-pci.service']);
assert.equal(run('systemctl',['is-active','code-ai-remote-pci.service']).trim(),'active');
console.log(JSON.stringify({installed:true,release,service:'code-ai-remote-pci.service',runAs:'admin',restartedExistingServices:false}));
