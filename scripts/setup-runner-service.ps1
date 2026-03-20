#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs the GitHub Actions self-hosted runner as a Windows service for auto-start.

.DESCRIPTION
    Registers C:\actions-runner\bin\RunnerService.exe as a Windows service that starts
    automatically on boot. This replaces the manual run.cmd approach and ensures the
    runner survives reboots.

.PARAMETER RunnerRoot
    Path to the runner installation directory. Defaults to C:\actions-runner.

.PARAMETER ServiceUser
    User account to run the service as. Defaults to the current user.
    Use "LocalSystem" for the SYSTEM account, or "domain\user" for a specific user.

.PARAMETER ServicePassword
    Password for the service account. Not required for LocalSystem.

.PARAMETER Uninstall
    Remove the service instead of installing it.

.EXAMPLE
    .\setup-runner-service.ps1
    # Installs with defaults (current runner config, LocalSystem account)

.EXAMPLE
    .\setup-runner-service.ps1 -ServiceUser "MYPC\runneruser" -ServicePassword "secret"
    # Installs under a specific user account

.EXAMPLE
    .\setup-runner-service.ps1 -Uninstall
    # Removes the service
#>
param(
    [string]$RunnerRoot = "C:\actions-runner",
    [string]$ServiceUser = "",
    [string]$ServicePassword = "",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# --- Resolve paths and config ---

$serviceExe = Join-Path $RunnerRoot "bin\RunnerService.exe"
$runnerConfig = Join-Path $RunnerRoot ".runner"

if (-not (Test-Path $serviceExe)) {
    Write-Error "RunnerService.exe not found at $serviceExe. Is the runner installed?"
    exit 1
}

if (-not (Test-Path $runnerConfig)) {
    Write-Error ".runner config not found at $runnerConfig. Run config.cmd first."
    exit 1
}

$config = Get-Content $runnerConfig -Raw | ConvertFrom-Json
$agentName = $config.agentName

# Parse the GitHub org/user from the URL
$gitHubUrl = $config.gitHubUrl
$urlParts = $gitHubUrl.TrimEnd('/') -split '/'
$orgName = $urlParts[-1]  # last segment (repo or org)
if ($urlParts.Count -ge 2) {
    $orgName = $urlParts[-2]  # prefer the owner segment
}

$serviceName = "actions.runner.$orgName.$agentName"
$displayName = "GitHub Actions Runner ($agentName)"

Write-Host "Runner root:    $RunnerRoot"
Write-Host "Agent name:     $agentName"
Write-Host "Service name:   $serviceName"
Write-Host "Service binary: $serviceExe"
Write-Host ""

# --- Uninstall path ---

if ($Uninstall) {
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "Service '$serviceName' is not installed. Nothing to do."
        exit 0
    }

    if ($existing.Status -eq "Running") {
        Write-Host "Stopping service..."
        Stop-Service -Name $serviceName -Force
        Start-Sleep -Seconds 3
    }

    Write-Host "Removing service..."
    sc.exe delete $serviceName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to delete service. Exit code: $LASTEXITCODE"
        exit 1
    }

    Write-Host "Service '$serviceName' removed successfully."
    exit 0
}

# --- Install path ---

# Check for existing service
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service '$serviceName' already exists (status: $($existing.Status))."
    Write-Host "Use -Uninstall to remove it first, then re-run this script."
    exit 1
}

# Stop any running run.cmd / Runner.Listener process
$listenerProc = Get-Process -Name "Runner.Listener" -ErrorAction SilentlyContinue
if ($listenerProc) {
    Write-Host "WARNING: Runner.Listener is currently running (PID: $($listenerProc.Id))."
    Write-Host "The service will be installed but cannot start until the listener process exits."
    Write-Host "After installation, stop run.cmd and the service will take over on next boot."
    Write-Host ""
}

# Install the service
Write-Host "Installing service..."

$binPath = "`"$serviceExe`""

if ($ServiceUser -and $ServiceUser -ne "LocalSystem") {
    sc.exe create $serviceName binPath= $binPath start= auto DisplayName= $displayName obj= $ServiceUser password= $ServicePassword | Out-Null
} else {
    sc.exe create $serviceName binPath= $binPath start= auto DisplayName= $displayName | Out-Null
}

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create service. Exit code: $LASTEXITCODE"
    exit 1
}

# Set description
sc.exe description $serviceName "GitHub Actions self-hosted runner for $gitHubUrl" | Out-Null

# Configure recovery: restart on first and second failure, reset counter after 1 day
sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/60000// | Out-Null

Write-Host "Service '$serviceName' installed successfully."
Write-Host ""

# Try to start the service (will fail if Runner.Listener is still running)
if (-not $listenerProc) {
    Write-Host "Starting service..."
    try {
        Start-Service -Name $serviceName
        Start-Sleep -Seconds 3

        $svc = Get-Service -Name $serviceName
        if ($svc.Status -eq "Running") {
            Write-Host "Service is running."
        } else {
            Write-Host "WARNING: Service status is '$($svc.Status)'. Check Event Viewer for errors."
        }
    } catch {
        Write-Host "WARNING: Could not start service: $_"
        Write-Host "The service will start automatically on next boot."
    }
} else {
    Write-Host "Skipping service start (Runner.Listener still active)."
    Write-Host "The service will start automatically on next boot."
}

# --- Verification ---
Write-Host ""
Write-Host "=== Verification ==="
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Service name:    $($svc.Name)"
    Write-Host "Display name:    $($svc.DisplayName)"
    Write-Host "Status:          $($svc.Status)"
    Write-Host "Start type:      $($svc.StartType)"
    Write-Host ""
    Write-Host "Done. The runner will start automatically on boot."
    Write-Host "To manage: sc.exe start/stop/query $serviceName"
} else {
    Write-Error "Service verification failed — service not found after installation."
    exit 1
}
