$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $ScriptDir 'export-standalone.mjs') @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
