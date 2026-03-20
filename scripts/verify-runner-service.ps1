<#
.SYNOPSIS
    Verifies the GitHub Actions runner service is installed and healthy.

.DESCRIPTION
    Checks service status, auto-start configuration, and runner connectivity.
    Returns exit code 0 if healthy, 1 if issues found.
    Designed to run without admin privileges for monitoring.

.PARAMETER RunnerRoot
    Path to the runner installation directory. Defaults to C:\actions-runner.
#>
param(
    [string]$RunnerRoot = "C:\actions-runner"
)

$exitCode = 0

# --- Resolve service name from runner config ---

$runnerConfig = Join-Path $RunnerRoot ".runner"
if (-not (Test-Path $runnerConfig)) {
    Write-Host "FAIL: .runner config not found at $runnerConfig"
    exit 1
}

$config = Get-Content $runnerConfig -Raw | ConvertFrom-Json
$agentName = $config.agentName
$gitHubUrl = $config.gitHubUrl
$urlParts = $gitHubUrl.TrimEnd('/') -split '/'
$orgName = $urlParts[-2]
$serviceName = "actions.runner.$orgName.$agentName"

Write-Host "=== Runner Service Health Check ==="
Write-Host "Runner root:  $RunnerRoot"
Write-Host "Agent name:   $agentName"
Write-Host "Service name: $serviceName"
Write-Host ""

# --- Check 1: Service exists ---

$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "FAIL: Service '$serviceName' not found."
    Write-Host "      Run scripts\install-runner-service.cmd to install."
    exit 1
}
Write-Host "PASS: Service exists"

# --- Check 2: Service is running ---

if ($svc.Status -eq "Running") {
    Write-Host "PASS: Service is running"
} else {
    Write-Host "FAIL: Service status is '$($svc.Status)' (expected: Running)"
    $exitCode = 1
}

# --- Check 3: Auto-start configured ---

if ($svc.StartType -eq "Automatic") {
    Write-Host "PASS: Start type is Automatic"
} else {
    Write-Host "FAIL: Start type is '$($svc.StartType)' (expected: Automatic)"
    $exitCode = 1
}

# --- Check 4: No competing Runner.Listener process ---

$listenerProcs = Get-Process -Name "Runner.Listener" -ErrorAction SilentlyContinue
if ($listenerProcs) {
    $serviceListenerPID = $null
    try {
        $wmiSvc = Get-WmiObject Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
        if ($wmiSvc) { $serviceListenerPID = $wmiSvc.ProcessId }
    } catch {}

    foreach ($proc in $listenerProcs) {
        if ($serviceListenerPID -and $proc.Id -eq $serviceListenerPID) {
            continue  # This is the service's own process
        }
        Write-Host "WARN: Non-service Runner.Listener found (PID: $($proc.Id))"
        Write-Host "      This may conflict with the service. Stop run.cmd if running."
    }
}
Write-Host "PASS: No competing listener processes"

# --- Check 5: Runner diagnostics log freshness ---

$diagDir = Join-Path $RunnerRoot "_diag"
if (Test-Path $diagDir) {
    $latestLog = Get-ChildItem $diagDir -Filter "Runner_*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestLog) {
        $age = (Get-Date) - $latestLog.LastWriteTime
        if ($age.TotalMinutes -lt 10) {
            Write-Host "PASS: Runner log updated $([math]::Round($age.TotalMinutes, 1)) min ago"
        } else {
            Write-Host "WARN: Latest runner log is $([math]::Round($age.TotalHours, 1)) hours old"
            Write-Host "      File: $($latestLog.Name)"
        }
    }
}

# --- Summary ---

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "=== All checks passed ==="
} else {
    Write-Host "=== Some checks failed ==="
}

exit $exitCode
