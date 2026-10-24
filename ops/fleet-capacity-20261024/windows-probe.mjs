import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const script=String.raw`
$ErrorActionPreference='Stop'
$paths=@()
$processes=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','powershell.exe','pwsh.exe','wscript.exe','codex.exe','ssh.exe') } | ForEach-Object {
 $command=[string]$_.CommandLine
 if($command -match '(?i)code.?ai|personal-computer|codex|44022'){
  $files=@([regex]::Matches($command,'(?i)(?:[A-Z]:\\[^"\r\n]*?\.(?:mjs|cjs|js|ps1|vbs))') | ForEach-Object {$_.Value})
  [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;executable=$_.ExecutablePath;files=$files}
 }
})
$tasks=@(Get-ScheduledTask | Where-Object {$_.TaskName -match '(?i)code.?ai'} | ForEach-Object {
 $task=$_;$info=Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath
 [pscustomobject]@{name=$task.TaskName;path=$task.TaskPath;state=[string]$task.State;lastResult=$info.LastTaskResult;actions=@($task.Actions|ForEach-Object{
  $files=@([regex]::Matches([string]$_.Arguments,'(?i)(?:[A-Z]:\\[^"\r\n]*?\.(?:mjs|cjs|js|ps1|vbs))')|ForEach-Object{$_.Value})
  [pscustomobject]@{execute=$_.Execute;files=$files}
 })}
})
$base=Join-Path $env:LOCALAPPDATA 'CodeAI'
$bins=@()
if(Test-Path (Join-Path $base 'bin')){
 $bins=@(Get-ChildItem -LiteralPath (Join-Path $base 'bin') -File | ForEach-Object{
  $text=[IO.File]::ReadAllText($_.FullName)
  $repo=[regex]::Match($text,'(?m)^\$repoDirectory\s*=\s*''([^'']*)''').Groups[1].Value
  [pscustomobject]@{file=$_.FullName;repoDirectory=$repo}
 })
}
[pscustomobject]@{hostname=$env:COMPUTERNAME;username=$env:USERNAME;localAppData=$env:LOCALAPPDATA;processes=$processes;tasks=$tasks;binFiles=$bins;disks=@(Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Free -ne $null}|ForEach-Object{[pscustomobject]@{name=$_.Name;free=$_.Free;used=$_.Used}})}|ConvertTo-Json -Depth 9 -Compress
`;
const {stdout}=await promisify(execFile)('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','personal-windows-ssh','powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:40000,maxBuffer:2*1024*1024});
const report=JSON.parse(stdout.replace(/^\uFEFF/,''));
await fs.writeFile('/root/projects/code-ai/ops/fleet-capacity-20261024/windows-before.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));
