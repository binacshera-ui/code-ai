import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const root = 'C:/Users/showp/.code-ai/remote-agent/window-control';
const taskName = 'CodeAI ME Console Window Control 20261008';
function remote(script, input) {
  const header = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;if($env:COMPUTERNAME -ne 'ME' -or $env:USERNAME -ne 'showp'){exit 41};";
  const result = spawnSync('/usr/bin/ssh', ['-F','/root/.ssh/personal-windows-new_config','-T',
    '-o','BatchMode=yes','-o','ConnectTimeout=8','personal-windows-new-ssh',
    'powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(header+script,'utf16le').toString('base64')],
  { input, encoding:'utf8', timeout:40000, maxBuffer:1024*1024 });
  if (result.status !== 0) throw new Error('WINDOW_CONTROL_FAILED_'+(result.status ?? result.error?.code));
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
const command = process.argv[2];
if (command === 'install') {
  remote(`if(!(Test-Path '${root}')){New-Item -ItemType Directory '${root}'|Out-Null};[pscustomobject]@{prepared=$true}|ConvertTo-Json -Compress`);
  for (const name of ['console-window.ps1','console-window.vbs','launch-hidden.vbs']) {
    const bytes = await fs.readFile(new URL(name,import.meta.url));
    if (bytes.length > 16000) throw new Error('WINDOWS_STDIN_LIMIT');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const result = remote(`$p='${root}/${name}';if(Test-Path $p){if((Get-FileHash $p -Algorithm SHA256).Hash.ToLower() -ne '${hash}'){exit 44}}else{$stream=[IO.File]::Create($p);try{[Console]::OpenStandardInput().CopyTo($stream)}finally{$stream.Dispose()}};if((Get-FileHash $p -Algorithm SHA256).Hash.ToLower() -ne '${hash}'){exit 45};[pscustomobject]@{installed='${name}';hashVerified=$true}|ConvertTo-Json -Compress`,bytes);
    console.log(JSON.stringify(result));
  }
} else if (command === 'inspect' || command === 'hide') {
  const mode = command === 'hide' ? 'Hide' : 'Inspect';
  const result = remote(`$name='${taskName}';$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;if($existing -and $existing.State -eq 'Running'){exit 46};$action=New-ScheduledTaskAction -Execute 'C:/Windows/System32/wscript.exe' -Argument '//B //NoLogo "${root}/console-window.vbs" ${mode}';$principal=New-ScheduledTaskPrincipal -UserId 'showp' -LogonType Interactive -RunLevel Limited;$settings=New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2)) -MultipleInstances IgnoreNew;if($existing){Set-ScheduledTask -TaskName $name -Action $action|Out-Null}else{Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings|Out-Null};$resultPath='${root}/result.json';$start=[DateTime]::UtcNow;Start-ScheduledTask -TaskName $name;for($i=0;$i -lt 80;$i++){if((Test-Path $resultPath) -and (Get-Item $resultPath).LastWriteTimeUtc -ge $start){$result=Get-Content $resultPath -Raw|ConvertFrom-Json;if($result.mode -eq '${mode}'){$result|ConvertTo-Json -Depth 7 -Compress;exit 0}};Start-Sleep -Milliseconds 250};$info=Get-ScheduledTaskInfo -TaskName $name;[pscustomobject]@{mode='${mode}';resultMissing=$true;taskResult=$info.LastTaskResult;taskState=[string](Get-ScheduledTask -TaskName $name).State}|ConvertTo-Json -Compress`);
  console.log(JSON.stringify(result));
} else if (command === 'configure-hidden') {
  console.log(JSON.stringify(remote(`$name='CodeAI Personal Computer Agent ME 20261008';$task=Get-ScheduledTask -TaskName $name;$before=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -like '*remote-agent/releases/20261008-v1/runner.mjs*'}|Select-Object -ExpandProperty ProcessId);if($before.Count -ne 1){exit 47};$backup='${root}/agent-task-before.xml';if(!(Test-Path $backup)){Export-ScheduledTask -TaskName $name|Set-Content -LiteralPath $backup -Encoding UTF8};$action=New-ScheduledTaskAction -Execute 'C:/Windows/System32/wscript.exe' -Argument '//B //NoLogo "${root}/launch-hidden.vbs"' -WorkingDirectory 'C:/Users/showp/.code-ai/remote-agent/releases/20261008-v1';Set-ScheduledTask -TaskName $name -Action $action|Out-Null;$after=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -like '*remote-agent/releases/20261008-v1/runner.mjs*'}|Select-Object -ExpandProperty ProcessId);[pscustomobject]@{futureLaunchHidden=$true;runnerPidUnchanged=($before.Count -eq 1 -and $after.Count -eq 1 -and $before[0] -eq $after[0]);taskState=[string](Get-ScheduledTask -TaskName $name).State}|ConvertTo-Json -Compress`)));
} else throw new Error('EXPECTED_INSTALL_INSPECT_HIDE_CONFIGURE_HIDDEN');
