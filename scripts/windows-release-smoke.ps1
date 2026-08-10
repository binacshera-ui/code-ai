param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [string]$SmokeRoot = (Join-Path $env:LOCALAPPDATA 'CodeAI\smoke\release'),

    [ValidateRange(1, 65535)]
    [int]$Port = 4011,

    [string]$ProfileId = 'personal-windows-codex',

    [string]$Workspace = 'C:\Users\user\Documents\New project',

    [string]$CodexHome = 'C:\Users\user\.codex',

    [string]$CodexBin = 'C:\Users\user\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serverPath = Join-Path $ReleaseRoot 'dist\server.js'
foreach ($requiredPath in @($ReleaseRoot, $serverPath, $Workspace, $CodexHome, $CodexBin)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required smoke-test path is missing: $requiredPath"
    }
}

New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
$token = 'smoke-' + [Guid]::NewGuid().ToString('N')
$profiles = @(
    @{
        id = $ProfileId
        label = 'Windows Codex Smoke'
        provider = 'codex'
        codexHome = $CodexHome
        workspaceCwd = $Workspace
        defaultProfile = $true
    }
)

$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = [string]$Port
$env:CODEX_APP_ROOT = $ReleaseRoot
$env:CODEX_STORAGE_ROOT = $SmokeRoot
$env:CODEX_UPLOAD_ROOT = Join-Path $SmokeRoot 'uploads'
$env:CODEX_QUEUE_ROOT = Join-Path $SmokeRoot 'queue'
$env:CODEX_LOG_ROOT = Join-Path $SmokeRoot 'logs'
$env:CODEX_OPEN_ACCESS = 'true'
$env:CODEX_ALLOW_ANY_PATHS = 'true'
$env:CODEX_PROFILES_JSON = ''
$profileJson = ConvertTo-Json -InputObject $profiles -Compress
$env:CODEX_PROFILES_JSON_BASE64 = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($profileJson)
)
$env:CODEX_BIN = $CodexBin
$env:CODEX_REMOTE_AGENT_TOKEN = $token
$env:SESSION_SECRET = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')

$stdoutPath = Join-Path $SmokeRoot 'server-out.log'
$stderrPath = Join-Path $SmokeRoot 'server-error.log'
$process = $null

try {
    $process = Start-Process `
        -FilePath 'C:\Program Files\nodejs\node.exe' `
        -ArgumentList ('"' + $serverPath + '"') `
        -WorkingDirectory $ReleaseRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $headers = @{ 'x-code-ai-remote-token' = $token }
    $healthUrl = "http://127.0.0.1:$Port/api/codex/remote-agent/health"
    $deadline = (Get-Date).AddSeconds(30)
    $health = $null

    do {
        Start-Sleep -Milliseconds 300
        try {
            $health = Invoke-WebRequest `
                -UseBasicParsing `
                -Uri $healthUrl `
                -Headers $headers `
                -TimeoutSec 3
        }
        catch {
            $health = $null
        }
        $process.Refresh()
        if ($process.HasExited) {
            throw "Smoke server exited with code $($process.ExitCode)"
        }
    }
    until ($null -ne $health -or (Get-Date) -gt $deadline)

    if ($null -eq $health) {
        throw 'Smoke health check timed out'
    }

    $sessionKey = 'draft-smoke-' + [Guid]::NewGuid().ToString('N')
    $paths = @(
        '/api/codex/remote-agent/health',
        "/api/codex/session-browser-mode?profileId=$ProfileId&sessionKey=$sessionKey",
        "/api/codex/session-design-mode?profileId=$ProfileId&sessionKey=$sessionKey",
        "/api/codex/session-ux-mode?profileId=$ProfileId&sessionKey=$sessionKey",
        "/api/codex/session-personal-chrome-mode?profileId=$ProfileId&sessionKey=$sessionKey"
    )

    $results = foreach ($path in $paths) {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri ("http://127.0.0.1:$Port" + $path) `
            -Headers $headers `
            -TimeoutSec 10
        $parsed = $response.Content | ConvertFrom-Json
        [pscustomobject]@{
            Path = $path.Split('?')[0]
            Status = [int]$response.StatusCode
            ContentType = [string]$response.Headers['Content-Type']
            JsonType = $parsed.GetType().Name
            Length = $response.Content.Length
        }
    }

    [pscustomobject]@{
        Ok = $true
        ReleaseRoot = $ReleaseRoot
        Port = $Port
        Results = @($results)
        StderrTail = if (Test-Path -LiteralPath $stderrPath) {
            [string]::Join("`n", [string[]](Get-Content -LiteralPath $stderrPath -Tail 80))
        }
        else {
            ''
        }
    } | ConvertTo-Json -Depth 6
}
catch {
    [pscustomobject]@{
        Ok = $false
        Error = $_.Exception.Message
        StdoutTail = if (Test-Path -LiteralPath $stdoutPath) {
            [string]::Join("`n", [string[]](Get-Content -LiteralPath $stdoutPath -Tail 80))
        }
        else {
            ''
        }
        StderrTail = if (Test-Path -LiteralPath $stderrPath) {
            [string]::Join("`n", [string[]](Get-Content -LiteralPath $stderrPath -Tail 80))
        }
        else {
            ''
        }
    } | ConvertTo-Json -Depth 6
    exit 1
}
finally {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
        }
    }
}
