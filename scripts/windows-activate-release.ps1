param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [string]$TaskName = 'CodeAI Personal Windows Agent',

    [string]$RunnerPath = (Join-Path $env:LOCALAPPDATA 'CodeAI\bin\run-personal-windows-agent.ps1'),

    [string]$PairingFile = (Join-Path $env:LOCALAPPDATA 'CodeAI\pairings\personal-windows.env'),

    [string]$ResultPath = (Join-Path $env:LOCALAPPDATA 'CodeAI\admin\windows-release-result.json'),

    [string]$ProfileId = 'personal-windows-codex',

    [ValidateRange(1, 65535)]
    [int]$HealthPort = 4010,

    [ValidateRange(15, 600)]
    [int]$HealthTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)

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

function Wait-AgentHealth {
    param(
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $url = "http://127.0.0.1:$Port/api/codex/remote-agent/health"
    do {
        try {
            $response = Invoke-WebRequest `
                -UseBasicParsing `
                -Uri $url `
                -Headers @{ 'x-code-ai-remote-token' = $Token } `
                -TimeoutSec 3
            if ([int]$response.StatusCode -eq 200) {
                return $true
            }
        }
        catch {
            # The task supervisor may still be restarting the agent.
        }
        Start-Sleep -Seconds 1
    }
    while ((Get-Date) -lt $deadline)
    return $false
}

function Write-ActivationResult {
    param([Parameter(Mandatory = $true)][hashtable]$Value)

    $directory = Split-Path -Parent $ResultPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporaryPath = "$ResultPath.$PID.tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        (($Value | ConvertTo-Json -Depth 6) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $ResultPath -Force
}

function Stop-AgentProcessTrees {
    param([Parameter(Mandatory = $true)][string]$ExpectedProfileId)

    $escapedProfileId = [regex]::Escape($ExpectedProfileId)
    $agents = @(
        Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match 'personal-computer-agent\.mjs' -and
            $_.CommandLine -match "--profile-id.+$escapedProfileId"
        }
    )
    foreach ($agent in $agents) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $agent.ProcessId /T /F *> $null
    }
}

function Test-ReleaseProcesses {
    param([Parameter(Mandatory = $true)][string]$ExpectedReleaseRoot)

    $normalizedRoot = $ExpectedReleaseRoot.TrimEnd('\')
    $expectedAgent = Join-Path $normalizedRoot 'scripts\personal-computer-agent.mjs'
    $expectedServer = Join-Path $normalizedRoot 'dist\server.js'
    $processes = @(Get-CimInstance Win32_Process)
    $agentRunning = @(
        $processes | Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -like ('*' + $expectedAgent + '*')
        }
    ).Count -gt 0
    $serverRunning = @(
        $processes | Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -like ('*' + $expectedServer + '*')
        }
    ).Count -gt 0
    return $agentRunning -and $serverRunning
}

$serverPath = Join-Path $ReleaseRoot 'dist\server.js'
$agentPath = Join-Path $ReleaseRoot 'scripts\personal-computer-agent.mjs'
foreach ($requiredPath in @(
    $ReleaseRoot,
    $serverPath,
    $agentPath,
    (Join-Path $ReleaseRoot 'node_modules'),
    $RunnerPath,
    $PairingFile
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required activation path is missing: $requiredPath"
    }
}

$token = Read-PairingValue -Path $PairingFile -Name 'CODEX_REMOTE_AGENT_TOKEN'
$runnerDirectory = Split-Path -Parent $RunnerPath
$backupDirectory = Join-Path $runnerDirectory 'release-backups'
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runnerBackup = Join-Path $backupDirectory "run-personal-windows-agent-$timestamp.ps1"
Copy-Item -LiteralPath $RunnerPath -Destination $runnerBackup -Force

$runnerText = [IO.File]::ReadAllText($RunnerPath)
$escapedReleaseRoot = $ReleaseRoot.Replace("'", "''")
$replacement = "`$repoDirectory = '$escapedReleaseRoot'"
$runnerPattern = [regex]::new('(?m)^\$repoDirectory\s*=\s*''[^'']*''\s*$')
$updatedRunner = $runnerPattern.Replace($runnerText, $replacement, 1)
if ($updatedRunner -eq $runnerText -and -not $runnerText.Contains($replacement)) {
    throw 'Runner repository path could not be updated or verified'
}

$runnerTemporary = "$RunnerPath.$PID.tmp"
[IO.File]::WriteAllText($runnerTemporary, $updatedRunner, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $runnerTemporary -Destination $RunnerPath -Force

$activated = $false
$rolledBack = $false
$rollbackHealthy = $false
$errorMessage = ''

try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Stop-AgentProcessTrees -ExpectedProfileId $ProfileId
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $TaskName

    $healthReady = Wait-AgentHealth `
        -Token $token `
        -Port $HealthPort `
        -TimeoutSeconds $HealthTimeoutSeconds
    if (-not $healthReady) {
        throw "Release health did not become ready within $HealthTimeoutSeconds seconds"
    }
    if (-not (Test-ReleaseProcesses -ExpectedReleaseRoot $ReleaseRoot)) {
        throw 'Health responded, but the expected release process tree is not active'
    }
    $activated = $true
}
catch {
    $errorMessage = $_.Exception.Message
    $rolledBack = $true
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Stop-AgentProcessTrees -ExpectedProfileId $ProfileId
    Start-Sleep -Seconds 2
    Copy-Item -LiteralPath $runnerBackup -Destination $RunnerPath -Force
    Start-ScheduledTask -TaskName $TaskName
    $rollbackHealthy = Wait-AgentHealth `
        -Token $token `
        -Port $HealthPort `
        -TimeoutSeconds $HealthTimeoutSeconds
}

$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
$result = @{
    version = 2
    completedAt = (Get-Date).ToString('o')
    releaseRoot = $ReleaseRoot
    activated = $activated
    rolledBack = $rolledBack
    rollbackHealthy = $rollbackHealthy
    error = $errorMessage
    runnerBackup = $runnerBackup
    taskState = [string]$task.State
    lastTaskResult = $taskInfo.LastTaskResult
    serverSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $serverPath).Hash
    agentSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $agentPath).Hash
}
Write-ActivationResult -Value $result
$result | ConvertTo-Json -Depth 6

if (-not $activated) {
    exit 1
}
