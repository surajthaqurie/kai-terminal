# Windows Environment & WebView2 Runtime Verification Script for Kai
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Kai Windows Prerequisite Verification" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Check WebView2 Runtime installation in registry
$wv2RegPath = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3C4FA00-6370-4771-B985-A754324F600E}"
$wv2UserPath = "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3C4FA00-6370-4771-B985-A754324F600E}"

$wv2Installed = (Test-Path $wv2RegPath) -or (Test-Path $wv2UserPath)

if ($wv2Installed) {
    Write-Host "[OK] Microsoft Edge WebView2 Runtime is installed." -ForegroundColor Green
} else {
    Write-Host "[WARNING] WebView2 Runtime not detected in standard registry path." -ForegroundColor Yellow
    Write-Host "Tauri 2 automatically prompts or bootstraps WebView2 on Windows 10/11 if needed." -ForegroundColor Yellow
}

# 2. Check PowerShell 7 / pwsh availability
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($pwsh) {
    Write-Host "[OK] PowerShell Core (pwsh.exe) found at: $($pwsh.Source)" -ForegroundColor Green
} else {
    Write-Host "[NOTE] PowerShell Core (pwsh.exe) not found; Windows PowerShell / cmd.exe will be used." -ForegroundColor LightGray
}

# 3. Check ConPTY compatibility (Windows build >= 18362)
$osBuild = [System.Environment]::OSVersion.Version.Build
if ($osBuild -ge 18362) {
    Write-Host "[OK] Windows build $osBuild supports native ConPTY infrastructure." -ForegroundColor Green
} else {
    Write-Host "[WARNING] Windows build $osBuild is below 18362. Legacy console fallback will be used." -ForegroundColor Yellow
}

Write-Host "=========================================" -ForegroundColor Cyan
