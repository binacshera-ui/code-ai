param(
  [Parameter(Mandatory=$true)][string]$ProfileDirectory,
  [Parameter(Mandatory=$true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
# Only identity metadata leaves this process. Never export Preferences/Local State.
if ($ProfileDirectory -notmatch '^(Default|Profile [0-9]+)$') { throw 'Select an explicit Chrome profile directory.' }
$chromeDataRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$chromeProfileRoot = Join-Path $chromeDataRoot $ProfileDirectory
$identityOutput = [IO.Path]::GetFullPath($OutputFile)
if ([IO.File]::Exists($identityOutput)) { throw 'Output exists; choose a new identity output file.' }
if ($identityOutput.StartsWith($chromeDataRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be outside Chrome user data.' }
$localState = [IO.File]::ReadAllText((Join-Path $chromeDataRoot 'Local State')) | ConvertFrom-Json
$profileInfo = $localState.profile.info_cache.PSObject.Properties[$ProfileDirectory].Value
if (-not $profileInfo -or -not $profileInfo.name) { throw 'The selected Chrome profile was not found.' }
$avatarDataUrl = $null
# The local GAIA picture file is optional. A Chrome built-in avatar is not guessed.
$pictureName = [string]$profileInfo.gaia_picture_file_name
if ($pictureName -and [IO.Path]::GetFileName($pictureName) -eq $pictureName) {
  $picturePath = Join-Path $chromeProfileRoot $pictureName
  if ([IO.File]::Exists($picturePath)) {
    Add-Type -AssemblyName System.Drawing
    $picture = [Drawing.Image]::FromFile($picturePath)
    $small = New-Object Drawing.Bitmap 96,96
    $graphics = [Drawing.Graphics]::FromImage($small)
    $stream = New-Object IO.MemoryStream
    try {
      $graphics.DrawImage($picture,0,0,96,96)
      $small.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
      $avatarDataUrl = 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray())
    } finally { $stream.Dispose(); $graphics.Dispose(); $small.Dispose(); $picture.Dispose() }
  }
}
$identity = @{ format='code-ai-chrome-profile'; version=1; profileIdentity=@{
  name=[string]$profileInfo.name; avatarDataUrl=$avatarDataUrl; source='chrome-local'
} }
[IO.File]::WriteAllText($identityOutput, ($identity | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
Write-Output 'Chrome identity exported. No credentials or browser history exported.'
