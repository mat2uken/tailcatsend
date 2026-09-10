# Tauri Windows WebView smoke check.
# Full peer transfer requires a second device and a selected Tailcat path.
$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $ProjectRoot

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "cargo is required" }
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw "go is required" }

& "$ProjectRoot\scripts\build_tauri.sh"
$binary = Join-Path $ProjectRoot "target\release\tailsend.exe"
if (-not (Test-Path $binary)) { throw "Tauri Windows binary was not generated: $binary" }

Write-Host "Tauri Windows WebView build passed: $binary" -ForegroundColor Green
Write-Host "Manual follow-up required: launch the binary, pair a second device, and record UDP/WebRTC/DERP separately."
