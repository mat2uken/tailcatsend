# ==============================================================================
# TailSend Automated Upstream Tailcat Updater & Builder (Windows / PowerShell)
# Usage:
#   .\scripts\update_tailcat.ps1              (defaults to upstream 'main' HEAD)
#   .\scripts\update_tailcat.ps1 -Target main
#   .\scripts\update_tailcat.ps1 -Target 7465d56
# ==============================================================================
param(
    [string]$Target = "main"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
$TailcatDir = Join-Path $ProjectRoot "tailcat"

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "         Tailcat Upstream Synchronizer & Builder          " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target: github.com/tailscale/tailcat@$Target" -ForegroundColor Yellow

# 1. Resolve Go Executable
$goExe = "go"
if (Test-Path "C:\Program Files\Go\bin\go.exe") {
    $goExe = "C:\Program Files\Go\bin\go.exe"
}

# 2. Update Tailcat Git Submodule & Apply Patches
Write-Host "`n[1/5] Updating Tailcat git submodule..." -ForegroundColor Yellow
$submoduleDir = Join-Path $TailcatDir "pkg\tailcat"
$patchFile = Join-Path $TailcatDir "patches\0001-android-selinux-netmon-fallback.patch"

git submodule sync --quiet
git submodule update --init --recursive --quiet

$commitHash = ""
$fullCommit = ""
Push-Location $submoduleDir
try {
    git fetch origin --tags --quiet
    git checkout --force $Target
    if ($Target -eq "main") {
        git pull --ff-only origin main
    }
    git reset --hard HEAD

    $commitHash = (git rev-parse --short=7 HEAD).Trim()
    $fullCommit = (git rev-parse HEAD).Trim()
    Write-Host "✓ Checked out submodule commit: $commitHash" -ForegroundColor Green

    if (Test-Path $patchFile) {
        git apply $patchFile
        Write-Host "✓ Applied local patch: $(Split-Path $patchFile -Leaf)" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}

# 3. Update Go Module and Metadata
Write-Host "`n[2/5] Updating Go module dependencies and metadata..." -ForegroundColor Yellow
Push-Location $TailcatDir
try {
    & $goExe mod tidy

    # Update bridgeVersion in bridge/web/main.go
    $bridgeMain = Join-Path $TailcatDir "bridge\web\main.go"
    if (Test-Path $bridgeMain) {
        $content = Get-Content $bridgeMain -Raw -Encoding UTF8
        $newContent = $content -replace '"bridgeVersion":\s*"[^"]*"', "`"bridgeVersion`": `"1.0.0-tailcat-$commitHash`""
        [System.IO.File]::WriteAllText($bridgeMain, $newContent, [System.Text.Encoding]::UTF8)
        Write-Host "✓ Updated bridgeVersion to: 1.0.0-tailcat-$commitHash" -ForegroundColor Green
    }

    # Update upstream.lock
    $lockFile = Join-Path $TailcatDir "upstream.lock"
    if (Test-Path $lockFile) {
        $content = Get-Content $lockFile -Raw -Encoding UTF8
        $newContent = $content -replace 'commit=[0-9a-f]+', "commit=$fullCommit"
        [System.IO.File]::WriteAllText($lockFile, $newContent, [System.Text.Encoding]::UTF8)
        Write-Host "✓ Updated upstream.lock to commit: $commitHash" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}

# 4. Build Native Daemon
Write-Host "`n[3/5] Compiling native tailcat daemon..." -ForegroundColor Yellow
Push-Location $TailcatDir
try {
    $outDaemon = Join-Path $ProjectRoot "target\release\tailcat_daemon.exe"
    $outDaemonDir = Split-Path $outDaemon -Parent
    if (-not (Test-Path $outDaemonDir)) { New-Item -ItemType Directory -Path $outDaemonDir -Force | Out-Null }

    & $goExe build -ldflags "-s -w" -o $outDaemon ./bridge/native/daemon.go
    if ($LASTEXITCODE -ne 0) { throw "Native daemon build failed" }
    $daemonSizeMB = [math]::Round((Get-Item $outDaemon).Length / 1MB, 2)
    Write-Host "✓ Built tailcat_daemon.exe ($daemonSizeMB MB)" -ForegroundColor Green
}
finally {
    Pop-Location
}

# 5. Build Web WASM Bridge and Gzip
Write-Host "`n[4/5] Compiling tailcat WebAssembly bridge..." -ForegroundColor Yellow
Push-Location $TailcatDir
try {
    $env:GOOS = "js"
    $env:GOARCH = "wasm"
    $outWasm = Join-Path $ProjectRoot "dist\assets\tailcat.wasm"
    $outWasmGz = Join-Path $ProjectRoot "dist\assets\tailcat.wasm.gz"

    & $goExe build -ldflags "-s -w" -o $outWasm ./bridge/web/main.go
    if ($LASTEXITCODE -ne 0) { throw "WASM build failed" }

    $rawBytes = [System.IO.File]::ReadAllBytes($outWasm)
    $fs = [System.IO.File]::Create($outWasmGz)
    $gzStream = [System.IO.Compression.GZipStream]::new($fs, [System.IO.Compression.CompressionLevel]::Optimal)
    $gzStream.Write($rawBytes, 0, $rawBytes.Length)
    $gzStream.Dispose()
    $fs.Dispose()

    $rawMB = [math]::Round($rawBytes.Length / 1MB, 2)
    $gzMB = [math]::Round((Get-Item $outWasmGz).Length / 1MB, 2)
    Write-Host "✓ Built tailcat.wasm: $rawMB MB (Gzip: $gzMB MB)" -ForegroundColor Green

    if ((Get-Item $outWasmGz).Length -gt 25MB) {
        throw "tailcat.wasm.gz exceeds Cloudflare Pages 25MB limit!"
    }
}
finally {
    $env:GOOS = ""
    $env:GOARCH = ""
    Pop-Location
}

# 6. Run Integration Test
Write-Host "`n[5/5] Running Tailcat WireGuard + DERP verification test..." -ForegroundColor Yellow
Push-Location $TailcatDir
try {
    & $goExe test -v -timeout 120s .\bridge\web\bridge_test.go
    if ($LASTEXITCODE -ne 0) { throw "Bridge integration test failed" }
    Write-Host "✓ Integration test passed!" -ForegroundColor Green
}
finally {
    Pop-Location
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "🎉 Tailcat successfully updated!" -ForegroundColor Green
Write-Host "   Submodule Commit: $commitHash ($fullCommit)" -ForegroundColor Green
Write-Host "   Native Daemon:    $outDaemon" -ForegroundColor Green
Write-Host "   WASM Asset:       $outWasmGz" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
