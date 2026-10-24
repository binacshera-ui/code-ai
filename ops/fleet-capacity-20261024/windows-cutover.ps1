param(
 [Parameter(Mandatory=$true)][string]$ReleaseRoot,
 [Parameter(Mandatory=$true)][string]$NodeBinary,
 [Parameter(Mandatory=$true)][string]$CodexBinary,
 [Parameter(Mandatory=$true)][string]$CodexHash,
 [Parameter(Mandatory=$true)][string]$ExpectedVersion
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
if($env:COMPUTERNAME -ne 'ME' -or $env:USERNAME -ne 'showp'){throw 'Wrong Windows identity'}
$text=& $NodeBinary 'C:/Users/showp/.code-ai/remote-agent/windows-cutover-prepare-20261024.mjs' $ReleaseRoot $CodexBinary $CodexHash | Out-String
if($LASTEXITCODE -ne 0){throw 'Cutover preparation failed'}
$prepared=$text|ConvertFrom-Json
if(!$prepared.prepared){throw 'Preparation did not confirm readiness'}
$name='CodeAI Personal Computer Agent ME 20261008'
$task=Get-ScheduledTask -TaskName $name
$oldActions=$task.Actions
$backup=$prepared.backup
Export-ScheduledTask -TaskName $name|Set-Content -LiteralPath ($backup+'/task-before.xml') -Encoding UTF8
$pairing=Get-Content 'C:/Users/showp/.code-ai/remote-agent/pairing.json' -Raw|ConvertFrom-Json
try{
 $action=New-ScheduledTaskAction -Execute 'C:/Windows/System32/wscript.exe' -Argument ('//B //NoLogo "'+$prepared.launcher+'"') -WorkingDirectory $prepared.candidate
 $q=Get-Content 'C:/Users/showp/.code-ai-remote/personal-windows-me/queue/state.json' -Raw|ConvertFrom-Json
 if(@($q.items|Where-Object{$_.status -in @('running','queued','cancelling')}).Count){throw 'Active work appeared; stop has not run'}
 Stop-ScheduledTask -TaskName $name
 Start-Sleep -Milliseconds 500
 $oldNodes=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Replace([char]92,[char]47).Contains('/remote-agent/releases/20261008-v1/')})
 foreach($oldNode in $oldNodes){Stop-Process -Id $oldNode.ProcessId -ErrorAction SilentlyContinue}
 Set-ScheduledTask -TaskName $name -Action $action|Out-Null
 Start-ScheduledTask -TaskName $name
 $deadline=(Get-Date).AddSeconds(60)
 $health=$null;$activated=$false
 do{
  try{
   $health=Invoke-RestMethod -Uri 'http://127.0.0.1:4010/api/codex/remote-agent/health' -Headers @{'x-code-ai-remote-token'=$pairing.token} -TimeoutSec 8
   if($health.ready -and $health.version -eq $ExpectedVersion){$activated=$true;break}
  }catch{}
  Start-Sleep -Milliseconds 500
 }while((Get-Date) -lt $deadline)
 if(!$activated){throw 'New runtime failed readiness'}
 $processes=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Replace([char]92,[char]47).Contains($ReleaseRoot)})
 if($processes.Count -lt 2){throw 'Candidate runner/server pair not proven'}
 $result=[pscustomobject]@{passed=$true;activated=$true;version=$health.version;ready=$health.ready;codexVersion=$health.codexVersion;runnerAndServerPids=@($processes|Select-Object -ExpandProperty ProcessId);backup=$backup;pairingCredentialsPreserved=$true;sshTasksTouched=$false;taskState=[string](Get-ScheduledTask -TaskName $name).State;nativeGuiStopped=$false}
 $result|ConvertTo-Json -Depth 6|Set-Content -LiteralPath ($backup+'/activation.json') -Encoding UTF8
 $result|ConvertTo-Json -Depth 6 -Compress
}catch{
 Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
 $failedNodes=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Replace([char]92,[char]47).Contains($ReleaseRoot)})
 foreach($failedNode in $failedNodes){Stop-Process -Id $failedNode.ProcessId -ErrorAction SilentlyContinue}
 Set-ScheduledTask -TaskName $name -Action $oldActions|Out-Null
 Start-ScheduledTask -TaskName $name
 throw 'Activation failed; previous task action restored; verified binary path and private backups retained'
}
