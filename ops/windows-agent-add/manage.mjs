import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { parseEnv } from 'node:util';

const base = '/root/projects/code-ai';
const id = 'personal-windows-me';
const label = 'המחשב האישי החדש — ME';
const privateFile = base + '/.code-ai/pairings/personal-windows-me.json';
const registryFile = base + '/.code-ai/remote-hosts.json';
const node = 'C:/Users/showp/AppData/Local/Programs/NodeJS/node-v24.20.0-win-x64/node.exe';
const release = 'C:/Users/showp/.code-ai/remote-agent/releases/20261008-v1';
const psHeader = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;if($env:COMPUTERNAME -ne 'ME' -or $env:USERNAME -ne 'showp'){exit 41};";
function remote(script, input, timeout = 60000) {
  const encoded = Buffer.from(psHeader + script, 'utf16le').toString('base64');
  const r = spawnSync('/usr/bin/ssh', ['-F','/root/.ssh/personal-windows-new_config','-T',
    '-o','BatchMode=yes','personal-windows-new-ssh','powershell.exe -NoProfile -NonInteractive -EncodedCommand '+encoded],
    { input, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error('REMOTE_OPERATION_FAILED_' + (r.status ?? r.error?.code));
  try { return JSON.parse(r.stdout.replace(/^\uFEFF/, '')); } catch { throw new Error('INVALID_REMOTE_METADATA'); }
}
async function transferArchive(script, archive) {
  // Windows OpenSSH stalls on large stdin transfers. HTTP stays inside a
  // temporary SSH forward; the package contains no pairing credentials.
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/package.zip') {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length });
    response.end(archive);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const tunnel = spawn('/usr/bin/ssh', ['-F','/root/.ssh/personal-windows-new_config','-N','-T',
    '-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8',
    '-R',`127.0.0.1:44400:127.0.0.1:${server.address().port}`,'personal-windows-new-ssh'], { stdio:['ignore','ignore','pipe'] });
  tunnel.stderr.resume();
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (tunnel.exitCode !== null) throw new Error('PRIVATE_TRANSFER_TUNNEL_FAILED');
    const encoded = Buffer.from(psHeader + script, 'utf16le').toString('base64');
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/ssh', ['-F','/root/.ssh/personal-windows-new_config','-T',
        '-o','BatchMode=yes','-o','ConnectTimeout=8','personal-windows-new-ssh',
        'powershell.exe -NoProfile -NonInteractive -EncodedCommand '+encoded], { stdio:['ignore','pipe','ignore'] });
      let stdout = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('PRIVATE_TRANSFER_TIMEOUT')); },120000);
      child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
      child.once('error', () => { clearTimeout(timer); reject(new Error('PRIVATE_TRANSFER_SPAWN_FAILED')); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error('PRIVATE_TRANSFER_FAILED_'+code));
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/,''))); }
        catch { reject(new Error('INVALID_TRANSFER_METADATA')); }
      });
    });
  } finally {
    tunnel.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[2] === 'prepare-pairing') {
  const current = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  if (current.hosts.some(h => h.id === id)) throw new Error('ALREADY_REGISTERED_CHECK_EXISTING_PAIRING');
  let pairing;
  try { pairing = JSON.parse(await fs.readFile(privateFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const env = parseEnv(await fs.readFile(base + '/.env', 'utf8'));
    const notifications = Object.fromEntries(['CODEX_NTFY_URL','CODEX_NTFY_ENABLED','CODEX_NTFY_DEFAULT_ENABLED',
      'CODEX_NTFY_ACCESS_TOKEN','CODEX_PUBLIC_ORIGIN'].filter(k => env[k]).map(k => [k, env[k]]));
    pairing = { id, label, token: crypto.randomBytes(32).toString('hex'),
      sessionSecret: crypto.randomBytes(32).toString('hex'), devicePassword: crypto.randomBytes(32).toString('hex'),
      codexBin: 'C:/Users/showp/AppData/Local/OpenAI/Codex/bin/9691020b546a15b2/codex.exe', notifications };
    await fs.writeFile(privateFile, JSON.stringify(pairing), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ status: 'pairing-prepared', id, secretsPrinted: false }));
} else if (process.argv[2] === 'install') {
  const packet = JSON.parse(await fs.readFile(base + '/ops/windows-agent-add/package-receipt.json', 'utf8'));
  const archive = await fs.readFile(packet.archive);
  if (crypto.createHash('sha256').update(archive).digest('hex') !== packet.sha256) throw new Error('PACKAGE_HASH_MISMATCH');
  remote(`$root='C:/Users/showp/.code-ai/remote-agent';$entries=if(Test-Path '${release}'){@(Get-ChildItem '${release}' -Force)}else{@()};if($entries.Count -gt 0 -and !($entries.Count -eq 1 -and $entries[0].Name -eq 'package.zip' -and $entries[0].Length -lt ${archive.length})){exit 44};if(Get-NetTCPConnection -LocalPort 44400 -State Listen -ErrorAction SilentlyContinue){exit 53};New-Item -ItemType Directory -Path '${release}' -Force|Out-Null;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;& icacls.exe $root /inheritance:r /grant:r ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F'|Out-Null;if($LASTEXITCODE -ne 0){exit 45};[pscustomobject]@{prepared=$true}|ConvertTo-Json -Compress`);
  const setup = await transferArchive(`$p='${release}/package-complete.zip';$downloaded=$false;$failureType='';$httpStatus=0;for($i=0;$i -lt 20;$i++){try{Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:44400/package.zip' -OutFile $p -TimeoutSec 90;$downloaded=$true;break}catch{$failureType=$_.Exception.GetType().FullName;if($_.Exception.Response){$httpStatus=[int]$_.Exception.Response.StatusCode};Start-Sleep -Milliseconds 500}};if(!$downloaded){[pscustomobject]@{packageVerified=$false;failureType=$failureType;httpStatus=$httpStatus;forwardListening=[bool](Get-NetTCPConnection -LocalPort 44400 -State Listen -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress;exit 0};if((Get-FileHash $p -Algorithm SHA256).Hash.ToLower() -ne '${packet.sha256}'){exit 46};try{Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory($p,'${release}')}catch{exit 55};[pscustomobject]@{packageVerified=$true;release='${release}'}|ConvertTo-Json -Compress`, archive);
  if (!setup.packageVerified) { console.log(JSON.stringify(setup)); throw new Error('PRIVATE_DOWNLOAD_FAILED'); }
  const privateBytes = await fs.readFile(privateFile);
  const paired = remote(`$p='C:/Users/showp/.code-ai/remote-agent/pairing.json';if(Test-Path $p){exit 47};$s=[IO.File]::Create($p);try{[Console]::OpenStandardInput().CopyTo($s)}finally{$s.Dispose()};$o=Get-Content -LiteralPath $p -Raw|ConvertFrom-Json;if($o.id -ne '${id}'){exit 48};[pscustomobject]@{paired=$true;nativePreparationRequired=$true}|ConvertTo-Json -Compress`, privateBytes, 60000);
  console.log(JSON.stringify({ ...setup, ...paired }));
} else if (process.argv[2] === 'finalize') {
  const r = remote(`$p=Get-Content 'C:/Users/showp/.code-ai/remote-agent/pairing.json' -Raw|ConvertFrom-Json;if($p.id -ne '${id}'){exit 48};$node='${node}';$ErrorActionPreference='Continue';$version=& $p.codexBin --version 2>$null;if($LASTEXITCODE -ne 0){exit 49};& $node '${release}/node_modules/node-pty/scripts/post-install.js' >'${release}/native-preparation.log' 2>&1;if($LASTEXITCODE -ne 0){exit 50};& $node -e "require('${release}/node_modules/node-pty/lib/index.js');process.stdout.write('native-ok')" >'${release}/native-check.log' 2>&1;if($LASTEXITCODE -ne 0){exit 51};[pscustomobject]@{codexVersion=[string]$version;nativeDependencyVerified=$true}|ConvertTo-Json -Compress`);
  console.log(JSON.stringify(r));
} else if (process.argv[2] === 'start') {
  const r = remote(`$name='CodeAI Personal Computer Agent ME 20261008';if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){exit 52};$launcher='C:/Users/showp/.code-ai/remote-agent/window-control/launch-hidden.vbs';if(!(Test-Path $launcher)){exit 56};$action=New-ScheduledTaskAction -Execute 'C:/Windows/System32/wscript.exe' -Argument '//B //NoLogo "C:/Users/showp/.code-ai/remote-agent/window-control/launch-hidden.vbs"' -WorkingDirectory '${release}';$trigger=New-ScheduledTaskTrigger -AtLogOn -User 'showp';$principal=New-ScheduledTaskPrincipal -UserId 'showp' -LogonType Interactive -RunLevel Limited;$settings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings|Out-Null;Start-ScheduledTask -TaskName $name;[pscustomobject]@{task=$name;started=$true}|ConvertTo-Json -Compress`);
  console.log(JSON.stringify(r));
} else if (process.argv[2] === 'health') {
  const r = remote(`$p=Get-Content 'C:/Users/showp/.code-ai/remote-agent/pairing.json' -Raw|ConvertFrom-Json;$r=Invoke-RestMethod -Uri 'http://127.0.0.1:4010/api/codex/remote-agent/health' -Headers @{'x-code-ai-remote-token'=$p.token};$denied=0;try{Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4010/api/codex/remote-agent/health'|Out-Null}catch{$denied=[int]$_.Exception.Response.StatusCode};[pscustomobject]@{ok=$r.ok;hostname=$r.hostname;codexVersion=$r.codexVersion;profiles=$r.profiles;unauthenticatedStatus=$denied}|ConvertTo-Json -Depth 6 -Compress`);
  if (!r.ok || r.hostname.toUpperCase() !== 'ME' || r.unauthenticatedStatus !== 401) throw new Error('AGENT_HEALTH_FAILED');
  console.log(JSON.stringify(r));
} else if (process.argv[2] === 'register') {
  const r = remote(`$p=Get-Content 'C:/Users/showp/.code-ai/remote-agent/pairing.json' -Raw|ConvertFrom-Json;$r=Invoke-RestMethod -Uri 'http://127.0.0.1:4010/api/codex/remote-agent/health' -Headers @{'x-code-ai-remote-token'=$p.token};[pscustomobject]@{ok=$r.ok;hostname=$r.hostname}|ConvertTo-Json -Compress`);
  if (!r.ok || r.hostname.toUpperCase() !== 'ME') throw new Error('AGENT_NOT_READY');
  const pairing = JSON.parse(await fs.readFile(privateFile, 'utf8'));
  const raw = await fs.readFile(registryFile, 'utf8');
  const registry = JSON.parse(raw);
  if (registry.version !== 1 || !Array.isArray(registry.hosts) || registry.hosts.some(h=>h.id===id)) throw new Error('REGISTRY_CONFLICT');
  const previousHosts = JSON.stringify(registry.hosts);
  registry.hosts.push({ id, label, transport: 'ssh', enabled: true, sshTarget: 'personal-windows-new-ssh',
    remotePort: 4010, token: pairing.token, description: 'מחשב Windows החדש ME · המשתמש showp · חיבור SSH פרטי' });
  if (JSON.stringify(registry.hosts.slice(0,-1)) !== previousHosts) throw new Error('EXISTING_HOST_CHANGED');
  if (await fs.readFile(registryFile,'utf8') !== raw) throw new Error('REGISTRY_CHANGED_CONCURRENTLY');
  await fs.copyFile(registryFile, base + '/.code-ai/pairings/remote-hosts-before-ME-20261008.json');
  await fs.chmod(base + '/.code-ai/pairings/remote-hosts-before-ME-20261008.json',0o600);
  const temp=registryFile+'.new-windows.tmp';
  await fs.writeFile(temp,JSON.stringify(registry,null,2)+'\n',{mode:0o600});
  await fs.rename(temp,registryFile);
  console.log(JSON.stringify({registered:true,id,label,existingHostsPreserved:true,oldComputerPreserved:registry.hosts.some(h=>h.id==='personal-windows')}));
} else throw new Error('EXPECTED_PREPARE_INSTALL_FINALIZE_START_HEALTH_OR_REGISTER');
