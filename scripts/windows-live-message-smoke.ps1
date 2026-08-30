param(
    [string]$PairingFile = (Join-Path $env:LOCALAPPDATA 'CodeAI\pairings\personal-windows.env'),

    [ValidateRange(1, 65535)]
    [int]$Port = 4010,

    [string]$ProfileId = 'personal-windows-codex',

    [string]$Workspace = 'C:\Users\user\Documents\New project'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-PairingValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line.StartsWith($Name + '=', [StringComparison]::Ordinal)) {
            return $line.Substring($Name.Length + 1).Trim()
        }
    }
    throw "Pairing value is missing: $Name"
}

function Invoke-CodeAiJson {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Get', 'Post')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [object]$Body,
        [int]$TimeoutSeconds = 180
    )

    $parameters = @{
        Method = $Method
        Uri = "http://127.0.0.1:$Port$Path"
        Headers = $Headers
        TimeoutSec = $TimeoutSeconds
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json; charset=utf-8'
        $parameters.Body = ConvertTo-Json -InputObject $Body -Compress -Depth 8
    }
    $response = Invoke-WebRequest @parameters
    return $response.Content | ConvertFrom-Json
}

if (-not (Test-Path -LiteralPath $PairingFile)) {
    throw "Pairing file is missing: $PairingFile"
}
if (-not (Test-Path -LiteralPath $Workspace)) {
    throw "Workspace is missing: $Workspace"
}

$token = Read-PairingValue -Path $PairingFile -Name 'CODEX_REMOTE_AGENT_TOKEN'
$headers = @{ 'x-code-ai-remote-token' = $token }
$requestId = [Guid]::NewGuid().ToString('N')
$queueKey = "draft:windows-hide-smoke:$requestId"

Invoke-CodeAiJson `
    -Method Post `
    -Path '/api/codex/session-final-notification' `
    -Headers $headers `
    -Body @{
        profileId = $ProfileId
        sessionKey = $queueKey
        enabled = $false
    } `
    -TimeoutSeconds 15 | Out-Null

$sourceIdentifier = 'CodeAI.WindowsHide.' + $requestId
$processEventJob = Register-WmiEvent `
    -Class Win32_ProcessStartTrace `
    -SourceIdentifier $sourceIdentifier `
    -Action {
        $started = $Event.SourceEventArgs.NewEvent
        $name = [string]$started.ProcessName
        if ($name -notin @('codex.exe', 'conhost.exe', 'cmd.exe')) {
            return
        }
        $liveProcess = Get-Process -Id ([int]$started.ProcessID) -ErrorAction SilentlyContinue
        [pscustomobject]@{
            ProcessName = $name
            ProcessId = [int]$started.ProcessID
            ParentProcessId = [int]$started.ParentProcessID
            SessionId = [int]$started.SessionID
            MainWindowHandle = if ($null -ne $liveProcess) {
                [int64]$liveProcess.MainWindowHandle
            }
            else {
                0
            }
            MainWindowTitle = if ($null -ne $liveProcess) {
                [string]$liveProcess.MainWindowTitle
            }
            else {
                ''
            }
            CapturedAt = (Get-Date).ToString('o')
        }
    }

$askResult = $null
$processStarts = @()
try {
    $askResult = Invoke-CodeAiJson `
        -Method Post `
        -Path '/api/codex/ask' `
        -Headers $headers `
        -Body @{
            profileId = $ProfileId
            queueKey = $queueKey
            clientRequestId = $requestId
            cwd = $Workspace
            prompt = 'This is an automated Windows child-process visibility smoke test. Do not use tools or modify files. Reply with exactly WINDOWS_HIDE_SMOKE_OK.'
        } `
        -TimeoutSeconds 240
}
finally {
    Start-Sleep -Milliseconds 750
    Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue
    $processStarts = @(
        Receive-Job -Job $processEventJob -ErrorAction SilentlyContinue | ForEach-Object {
            [pscustomobject]@{
                ProcessName = [string]$_.ProcessName
                ProcessId = [int]$_.ProcessId
                ParentProcessId = [int]$_.ParentProcessId
                SessionId = [int]$_.SessionId
                MainWindowHandle = [int64]$_.MainWindowHandle
                MainWindowTitle = [string]$_.MainWindowTitle
                CapturedAt = [string]$_.CapturedAt
            }
        }
    )
    Remove-Job -Job $processEventJob -Force -ErrorAction SilentlyContinue
}

$sessionId = [string]$askResult.session.id
if ([string]::IsNullOrWhiteSpace($sessionId)) {
    throw 'The live message smoke test did not return a session id'
}

Invoke-CodeAiJson `
    -Method Post `
    -Path ("/api/codex/sessions/$sessionId/hide") `
    -Headers $headers `
    -Body @{
        profileId = $ProfileId
        hidden = $true
    } `
    -TimeoutSeconds 15 | Out-Null

$visibleConsoleStarts = @(
    $processStarts | Where-Object {
        $_.ProcessName -in @('conhost.exe', 'cmd.exe') -and
        $_.MainWindowHandle -ne 0
    }
)

[pscustomobject]@{
    Ok = ([string]$askResult.finalMessage).Trim() -eq 'WINDOWS_HIDE_SMOKE_OK'
    SessionId = $sessionId
    SessionHidden = $true
    FinalMessage = [string]$askResult.finalMessage
    ProcessStarts = $processStarts
    VisibleConsoleStarts = $visibleConsoleStarts.Count
} | ConvertTo-Json -Depth 8

if (([string]$askResult.finalMessage).Trim() -ne 'WINDOWS_HIDE_SMOKE_OK') {
    exit 1
}
if ($visibleConsoleStarts.Count -ne 0) {
    exit 2
}
