# Scoped 1.4.5 -> 1.4.6 file installation. Does not reload Chrome, change
# extension storage, contact CODE-AI, or touch authentication/server/jobs.
param(
  [Parameter(Mandatory=$true)][string]$StageRoot,
  [Parameter(Mandatory=$true)][string]$QualificationResult
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = 'C:\Users\user\Desktop\CODE-AI-Chrome-Extension'
$backup = 'C:\Users\user\Desktop\CODE-AI-Chrome-Extension-backup-1.4.5-20261005-Mdvt2e'
$candidate = Join-Path $StageRoot 'candidate'
$expected = @{
  'panelOpen.js' = '46375e05fdbd0a1fa63f8bbfb1184bb8097438c25f6e5411c03c00badd59e6b7'
  'background.js' = 'fe5d1f60f5376dcde564d322fcb89190345660efdc1e0f58b0ff5b79b2393cec'
  'README.md' = 'b5327015d107a7743afac6c2032a67577d3c660b9a66838334266dfe62320bf3'
  'manifest.json' = '1f08149a3789a3a25ed52c53649dc8ade6e9580e389d444c89c10da575a53595'
}
$previous = @{
  'panelOpen.js' = 'b15c0234fe121132a06399779e4190a5a45b59814d33474328bc39def83abc54'
  'background.js' = 'e117ad33515a4d26859babfae582021a73e23ffe8b61655c3246a6f1c3bb95ab'
  'manifest.json' = '7e23745ac5fd89f4fbb5d62582db15791455c6aec7d3a7e4ae6105b21db1a513'
}
$files = @('panelOpen.js','background.js','README.md','manifest.json')
function FileHash([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() }

$qualification = Get-Content -LiteralPath $QualificationResult -Raw | ConvertFrom-Json
$passed = @($qualification.results | Where-Object {
  $_.case -eq 'candidate' -and $_.completed -eq 30 -and $null -eq $_.firstFailure -and
  $_.actionEvents -eq 30 -and $_.openedEvents -eq 30 -and $_.closedEvents -eq 30 -and
  $_.backgroundSha256 -eq $expected['background.js'] -and $_.helperSha256 -eq $expected['panelOpen.js']
})
if ($passed.Count -ne 1) { throw 'Native browser qualification did not pass for these exact files.' }

if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected installation target.' }
$backupExists = Test-Path -LiteralPath $backup
$manifest = Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne '1.4.5') { throw 'Installed version changed; review before replacing files.' }
foreach ($file in $files) {
  if ((FileHash (Join-Path $candidate $file)) -ne $expected[$file]) { throw ('Candidate mismatch: ' + $file) }
  if ($previous.ContainsKey($file) -and (FileHash (Join-Path $target $file)) -ne $previous[$file]) {
    throw ('Installed file changed concurrently: ' + $file)
  }
}
$protected = @{}
foreach ($file in @('panel.html','panel.js','selectionAccess.js')) { $protected[$file] = FileHash (Join-Path $target $file) }
if (-not $backupExists) { $null = New-Item -ItemType Directory -Path $backup }
foreach ($file in $files) {
  if (-not $backupExists) {
    Copy-Item -LiteralPath (Join-Path $target $file) -Destination (Join-Path $backup $file)
  }
  # An interrupted pre-write attempt can reuse its exact verified backup,
  # but may never replace or silently trust an existing predecessor copy.
  if ((FileHash (Join-Path $backup $file)) -ne (FileHash (Join-Path $target $file))) { throw ('Backup mismatch: ' + $file) }
}
$installed = @()
try {
  foreach ($file in $files) {
    $temporary = Join-Path $StageRoot ($file + '.ready-' + [guid]::NewGuid().ToString() + '.tmp')
    Copy-Item -LiteralPath (Join-Path $candidate $file) -Destination $temporary
    # Windows PowerShell coerces a null string argument to an invalid empty
    # path; supply an explicit, unique displaced-file path instead.
    [IO.File]::Replace($temporary, (Join-Path $target $file), ($temporary + '.predecessor'))
    $installed += $file
    if ((FileHash (Join-Path $target $file)) -ne $expected[$file]) { throw ('Installed mismatch: ' + $file) }
  }
  foreach ($file in $protected.Keys) {
    if ((FileHash (Join-Path $target $file)) -ne $protected[$file]) { throw ('Unrelated file changed: ' + $file) }
  }
} catch {
  foreach ($file in $installed) {
    if ((FileHash (Join-Path $target $file)) -ne $expected[$file]) {
      throw ('Concurrent modification; manual rollback review required: ' + $file)
    }
    Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $target $file) -Force
  }
  throw
}
$receipt = [pscustomobject]@{
  version = '1.4.6'; target = $target; backup = $backup
  files = @($files | ForEach-Object { [pscustomobject]@{file=$_;sha256=(FileHash (Join-Path $target $_))} })
  protectedFilesUnchanged = $true; authenticationUnchanged = $true
  serverRestart = $false; chromeRestart = $false; activation = 'awaiting Chrome extension Reload'
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $StageRoot 'install-receipt.json') -Encoding UTF8
$receipt | ConvertTo-Json -Depth 5 -Compress
