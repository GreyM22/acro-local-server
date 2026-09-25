# Wipes leftover "Acro Local Server" install/app data on Windows so a fresh
# install works even after a broken/incomplete uninstall.
#
# What it removes:
#   - The installed program folder  (%LOCALAPPDATA%\Programs\Acro Local Server)
#   - Electron's userData folder    (%APPDATA%\Acro Local Server)  - cache, logs, settings
#   - The leftover uninstall registry key (HKCU, since the app installs per-user)
#
# What it does NOT touch:
#   - ~/Desktop/AcroVideos (your recorded videos + .metadata.json)
#
# Usage (in PowerShell, as the same Windows user who installed the app):
#   powershell -ExecutionPolicy Bypass -File windows-clean-reinstall.ps1

$ErrorActionPreference = 'SilentlyContinue'
$AppName = 'Acro Local Server'

Write-Host "Stopping any running '$AppName' process..."
Get-Process | Where-Object { $_.ProcessName -like '*Acro Local Server*' } | Stop-Process -Force

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$AppDataDir = Join-Path $env:APPDATA $AppName

if (Test-Path $InstallDir) {
    Write-Host "Removing install directory: $InstallDir"
    Remove-Item -Recurse -Force $InstallDir
} else {
    Write-Host "No install directory found at $InstallDir"
}

if (Test-Path $AppDataDir) {
    Write-Host "Removing app data directory: $AppDataDir"
    Remove-Item -Recurse -Force $AppDataDir
} else {
    Write-Host "No app data directory found at $AppDataDir"
}

Write-Host "Removing leftover uninstall registry entries..."
$UninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $UninstallRoots) {
    if (Test-Path $root) {
        Get-ChildItem $root | ForEach-Object {
            $displayName = (Get-ItemProperty $_.PSPath).DisplayName
            if ($displayName -eq $AppName) {
                Write-Host "Removing registry key: $($_.PSPath)"
                Remove-Item -Recurse -Force $_.PSPath
            }
        }
    }
}

Write-Host ""
Write-Host "Done. Your videos in Desktop\AcroVideos were left untouched."
Write-Host "You can now run the '$AppName' installer again."