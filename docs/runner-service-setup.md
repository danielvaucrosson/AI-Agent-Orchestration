# GitHub Actions Runner — Windows Service Setup

The self-hosted runner at `C:\actions-runner` can be installed as a Windows service so it starts automatically on boot and survives reboots without manual intervention.

## Quick Install

Run as administrator:

```powershell
.\scripts\setup-runner-service.ps1
```

Or double-click `scripts\install-runner-service.cmd` (it self-elevates).

## What It Does

1. Reads the runner config from `C:\actions-runner\.runner`
2. Registers `RunnerService.exe` as a Windows service named `actions.runner.<org>.<agent>`
3. Sets the service to **Automatic** start
4. Configures failure recovery (auto-restart after 60s on crash)
5. Starts the service (if no competing `run.cmd` process is active)

## Prerequisites

- Runner already configured via `config.cmd` (`.runner` and `.credentials` files exist)
- Administrator privileges
- If the runner is currently running via `run.cmd`, stop it first — or let the service take over on next reboot

## Switching from run.cmd to Service

If the runner is currently started manually:

1. Wait for any active jobs to finish
2. Stop `run.cmd` (Ctrl+C or close the terminal)
3. Run the install script (as admin)
4. The service starts immediately and handles future jobs

## Managing the Service

```powershell
# Check status
sc.exe query actions.runner.danielvaucrosson.local-laptop

# Stop the service
sc.exe stop actions.runner.danielvaucrosson.local-laptop

# Start the service
sc.exe start actions.runner.danielvaucrosson.local-laptop

# Remove the service
.\scripts\setup-runner-service.ps1 -Uninstall
```

## Verification

Run the health check (no admin required):

```powershell
.\scripts\verify-runner-service.ps1
```

This checks:
- Service exists and is running
- Start type is Automatic
- No competing `Runner.Listener` processes
- Runner logs are recent

## Reboot Test

To verify the service survives a reboot:

1. Install the service
2. Run `verify-runner-service.ps1` — all checks should pass
3. Restart the machine
4. After boot, run `verify-runner-service.ps1` again
5. Queue a workflow run and confirm the runner picks it up

## Troubleshooting

**Service won't start:** Check Event Viewer > Windows Logs > Application for errors from `RunnerService`. Common causes: missing `.credentials` file, network issues, or another listener holding the lock.

**Service installed but showing "Stopped":** If `run.cmd` is still active, the service can't bind the listener. Stop `run.cmd` first, then `sc.exe start <service-name>`.

**Wrong service account:** By default the service runs as LocalSystem. To use a specific account:

```powershell
.\scripts\setup-runner-service.ps1 -ServiceUser "MACHINE\user" -ServicePassword "pass"
```
