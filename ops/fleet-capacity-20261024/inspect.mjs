import fs from 'node:fs/promises';
import {targets,linux,windows} from './remote.mjs';
const ops='/root/projects/code-ai/ops/fleet-capacity-20261024';
const main=(await fs.realpath('/root/projects/code-ai/dist')).slice(0,-5);
const sourceManifest=JSON.parse(await fs.readFile(main+'/release-files.json','utf8'));
for(const target of (process.argv[2]==='windows'?[]:Object.values(targets))){
 const report=await linux(target,`
  import fs from'node:fs/promises';import path from'node:path';import{execFileSync}from'node:child_process';import{parseEnv}from'node:util';
  const root=execFileSync('systemctl',['show',${JSON.stringify(target.service)},'-p','WorkingDirectory','--value'],{encoding:'utf8'}).trim();
  const req=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));
  const manifest=JSON.parse(await fs.readFile(root+'/release-files.json','utf8'));
  const env=parseEnv(await fs.readFile(req.environmentFile,'utf8'));
  const names=['CODEX_PROFILES_JSON','CODEX_PROFILES_JSON_BASE64'];
  const profiles=JSON.parse(env.CODEX_PROFILES_JSON||Buffer.from(env.CODEX_PROFILES_JSON_BASE64||'W10=','base64').toString());
  const owners=[];for(const p of profiles.filter(p=>p.provider==='codex'||!p.provider)){
   const home=path.dirname(p.codexHome);
   try{const owner=JSON.parse(await fs.readFile(home+'/code-ai-native-owner/ownership.json','utf8'));owners.push({profile:p.id,pid:owner.nativePid,generation:owner.nativeIdentity.startTime,brokerSha:owner.brokerModuleSha256})}catch{}
  }
  const config=await fs.readFile('/home/'+${JSON.stringify(target.id==='pci'?'binapay-admin':'beamadmin')}+'/.ssh/config','utf8').catch(()=>'');
  console.log(JSON.stringify({root,manifest,owners,profiles:profiles.map(p=>({id:p.id,codexHome:p.codexHome,workspaceCwd:p.workspaceCwd})),sshAliases:[...config.matchAll(/^Host\s+(.+)$/gm)].map(m=>m[1]),hasFeatureEnv:!!req.featureEnvironmentFile}));
 `);
 await fs.writeFile(ops+'/'+target.id+'-source.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 const differing=Object.entries(report.manifest.files).filter(([name,sha])=>sourceManifest.files[name]&&sourceManifest.files[name]!==sha).map(([name])=>name);
 const extra=Object.keys(report.manifest.files).filter(name=>!sourceManifest.files[name]);
 console.log(JSON.stringify({id:target.id,root:report.root,owners:report.owners,profiles:report.profiles,sshAliases:report.sshAliases,changedFromMain:differing,extraTargetFiles:extra}));
}
const report=await windows(String.raw`
$root='C:/Users/showp/.code-ai/remote-agent/releases/20261008-v1'
$p=Get-Content 'C:/Users/showp/.code-ai/remote-agent/pairing.json' -Raw|ConvertFrom-Json
$runnerHash=(Get-FileHash ($root+'/runner.mjs') -Algorithm SHA256).Hash.ToLower()
$runnerText=[IO.File]::ReadAllText($root+'/runner.mjs')
$health=Invoke-RestMethod -Uri 'http://127.0.0.1:4010/api/codex/remote-agent/health' -Headers @{'x-code-ai-remote-token'=$p.token}
$state='C:/Users/showp/.code-ai-remote/personal-windows-me/queue/state.json'
$q=Get-Content $state -Raw|ConvertFrom-Json
$node='C:/Users/showp/AppData/Local/Programs/NodeJS/node-v24.20.0-win-x64/node.exe'
$configuredBinaryExists=Test-Path -LiteralPath $p.codexBin
$nativeVersion=if($configuredBinaryExists){(& $p.codexBin --version 2>$null|Out-String).Trim()}else{''}
$runningBinaries=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'codex.exe'}|Select-Object -ExpandProperty ExecutablePath -Unique|ForEach-Object{
 $version=(& $_ --version 2>$null|Out-String).Trim()
 [pscustomobject]@{path=$_;version=$version;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLower()}
})
$sshConfig=if(Test-Path 'C:/Users/showp/.ssh/config'){[IO.File]::ReadAllText('C:/Users/showp/.ssh/config')}else{''}
$launcher='C:/Users/showp/.code-ai/remote-agent/window-control/launch-hidden.vbs'
[pscustomobject]@{root=$root;node=$node;codexBin=$p.codexBin;configuredBinaryExists=$configuredBinaryExists;codexVersion=$nativeVersion;runningBinaries=$runningBinaries;runnerHash=$runnerHash;runnerText=$runnerText;launcherText=[IO.File]::ReadAllText($launcher);healthVersion=$health.version;queueCounts=@($q.items|Group-Object status|Select-Object Name,Count);activeWork=@($q.items|Where-Object{$_.status -in @('running','queued','cancelling')}|Select-Object id,status,profileId);nodeModules=(Test-Path ($root+'/node_modules'));sshAliases=@([regex]::Matches($sshConfig,'(?m)^Host\s+(.+)$')|ForEach-Object{$_.Groups[1].Value})}|ConvertTo-Json -Depth 8 -Compress
`);
await fs.writeFile(ops+'/windows-source.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
const {runnerText,launcherText,...publicReport}=report;
console.log(JSON.stringify(publicReport));
