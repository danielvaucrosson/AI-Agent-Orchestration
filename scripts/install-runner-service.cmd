@echo off
rem Installs the GitHub Actions runner as a Windows service with auto-start.
rem This script self-elevates to admin if needed.

echo === GitHub Actions Runner Service Installer ===
echo.

rem Check for admin privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    PowerShell -Command "Start-Process -Verb RunAs -FilePath '%~dp0setup-runner-service.ps1' -Wait"
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Administrator privileges required. Please run as admin.
        pause
        exit /b 1
    )
) else (
    PowerShell -ExecutionPolicy Bypass -File "%~dp0setup-runner-service.ps1"
)

echo.
pause
