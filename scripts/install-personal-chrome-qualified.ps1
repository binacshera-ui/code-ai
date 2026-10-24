param(
  [Parameter(Mandatory=$true)][string]$Candidate,
  [Parameter(Mandatory=$true)][string]$HashesFile,
  [Parameter(Mandatory=$true)][string]$PanelQualification,
  [Parameter(Mandatory=$true)][string]$WorkerQualification
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$target='C:\Users\user\Desktop\CODE-AI-Chrome-Extension'
$expected=[IO.File]::ReadAllText($HashesFile)|ConvertFrom-Json
$panel=[IO.File]::ReadAllText($PanelQualification)|ConvertFrom-Json
$worker=[IO.File]::ReadAllText($WorkerQualification)|ConvertFrom-Json
function Hash([string]$file){return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()}
function AssertRegularTree([string]$root){
  if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected directory is not an installation target'}
  if(@(Get-ChildItem -LiteralPath $root -Recurse -Force|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Redirected files require separate review'}
}
AssertRegularTree $target
AssertRegularTree $Candidate
$background=$expected.files.PSObject.Properties['background.js'].Value
$passed=@($panel.results|Where-Object{$_.case -eq 'candidate' -and $_.completed -eq 30 -and $null -eq $_.firstFailure -and $_.backgroundSha256 -eq $background})
if($passed.Count -ne 1){throw 'These bytes did not pass real panel qualification'}
if(-not ($worker.ok -and $worker.fullWorker -and $worker.isolatedProfile -and $worker.syntheticAuthenticationOnly -and -not $worker.panelOpened -and $worker.workspacesPreserved -and $worker.reconnected -and $worker.idleSeconds -ge 65 -and $worker.backgroundSha256 -eq $background)){throw 'These bytes did not pass complete worker qualification'}
foreach($name in @('background.js','bridgeTransport.js','profileIdentity.js','panelOpen.js','selectionAccess.js','manifest.json')){
  if($worker.moduleHashes.PSObject.Properties[$name].Value -ne $expected.files.PSObject.Properties[$name].Value){throw ('Native worker module mismatch: '+$name)}
}
$oldManifest=[IO.File]::ReadAllText((Join-Path $target 'manifest.json'))|ConvertFrom-Json
if($oldManifest.version -ne '1.4.6'){throw 'Installed predecessor changed; no files replaced'}
$newManifest=[IO.File]::ReadAllText((Join-Path $Candidate 'manifest.json'))|ConvertFrom-Json
if($newManifest.version -ne '1.5.0' -or $expected.version -ne '1.5.0'){throw 'Unexpected candidate version'}
foreach($file in $expected.files.PSObject.Properties){
  if([IO.Path]::GetFileName($file.Name) -ne $file.Name){throw 'Package path is not a flat extension file'}
  if((Hash (Join-Path $Candidate $file.Name)) -ne $file.Value){throw ('Candidate digest mismatch: '+$file.Name)}
}
$before=@{}
foreach($file in Get-ChildItem -LiteralPath $target -File -Recurse -Force){$before[$file.FullName]=Hash $file.FullName}
$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$ready=Join-Path (Split-Path -Parent $Candidate) ('install-ready-'+$stamp)
$backup=$target+'-backup-1.4.6-'+$stamp
Copy-Item -LiteralPath $target -Destination $ready -Recurse
foreach($file in $expected.files.PSObject.Properties){Copy-Item -LiteralPath (Join-Path $Candidate $file.Name) -Destination (Join-Path $ready $file.Name) -Force}
foreach($file in $expected.files.PSObject.Properties){if((Hash (Join-Path $ready $file.Name)) -ne $file.Value){throw 'Staged copy mismatch'}}
foreach($file in $before.Keys){if((Hash $file) -ne $before[$file]){throw 'Installation changed concurrently; no files replaced'}}
if(@(Get-ChildItem -LiteralPath $target -File -Recurse -Force).Count -ne $before.Count){throw 'Installation changed concurrently; no files replaced'}
Move-Item -LiteralPath $target -Destination $backup
try {Move-Item -LiteralPath $ready -Destination $target}
catch {Move-Item -LiteralPath $backup -Destination $target;throw}
$receipt=[pscustomobject]@{filesInstalled=$true;version='1.5.0';target=$target;backup=$backup;buildId=$expected.buildId;panelNativeCycles=30;fullWorkerQualified=$true;chromeStorageUnchanged=$true;authenticationUnchanged=$true;chromeRestart=$false;serverRestart=$false;activation='awaiting Chrome extension Reload'}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Candidate) 'install-receipt.json'),($receipt|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding $false))
$receipt|ConvertTo-Json -Depth 4 -Compress
