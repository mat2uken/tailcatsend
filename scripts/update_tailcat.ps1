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

# 2. Update Go Module
Write-Host "`n[1/5] Fetching upstream tailcat module..." -ForegroundColor Yellow
Push-Location $TailcatDir
try {
    & $goExe get "github.com/tailscale/tailcat@$Target"
    & $goExe mod tidy

    # Get resolved module info
    $modInfoJson = & $goExe list -m -json github.com/tailscale/tailcat | Out-String
    $modInfo = $modInfoJson | ConvertFrom-Json
    $version = $modInfo.Version
    Write-Host "✓ Resolved Tailcat version: $version" -ForegroundColor Green

    # Extract short commit hash
    $commitHash = ""
    if ($version -match "-([0-9a-f]{12})$") {
        $commitHash = $matches[1].Substring(0, 7)
    } elseif ($version -match "^v?([0-9a-f]{7,40})") {
        $commitHash = $matches[1].Substring(0, 7)
    } else {
        $commitHash = $Target
    }

    # Update bridgeVersion in bridge/web/main.go
    $bridgeMain = Join-Path $TailcatDir "bridge\web\main.go"
    if (Test-Path $bridgeMain) {
        $content = Get-Content $bridgeMain -Raw -Encoding UTF8
        $newContent = $content -replace '"bridgeVersion":\s*"[^"]*"', "`"bridgeVersion`": `"1.0.0-tailcat-$commitHash`""
        [System.IO.File]::WriteAllText($bridgeMain, $newContent, [System.Text.Encoding]::UTF8)
        Write-Host "✓ Updated bridgeVersion to: 1.0.0-tailcat-$commitHash" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}

# 3. Synchronize local vendor/browse copy in tailcat/pkg/tailcat
Write-Host "`n[2/5] Updating local source mirror in tailcat/pkg/tailcat..." -ForegroundColor Yellow
$localMirrorDir = Join-Path $TailcatDir "pkg\tailcat"
$tempCloneDir = Join-Path $env:TEMP "tailcat_upstream_sync"
if (Test-Path $tempCloneDir) { Remove-Item -Recurse -Force $tempCloneDir -ErrorAction SilentlyContinue }

try {
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    git clone --quiet --depth 1 "https://github.com/tailscale/tailcat.git" $tempCloneDir 2>&1 | Out-Null
    $ErrorActionPreference = $oldEap
    if (Test-Path $tempCloneDir) {
        if (-not (Test-Path $localMirrorDir)) {
            New-Item -ItemType Directory -Path $localMirrorDir -Force | Out-Null
        }
        Get-ChildItem -Path $tempCloneDir -Recurse | Where-Object { $_.FullName -notmatch '\\\.git($|\\)' } | ForEach-Object {
            $rel = $_.FullName.Substring($tempCloneDir.Length + 1)
            $destPath = Join-Path $localMirrorDir $rel
            if ($_.PSIsContainer) {
                if (-not (Test-Path $destPath)) { New-Item -ItemType Directory -Path $destPath -Force | Out-Null }
            } else {
                $p = Split-Path $destPath -Parent
                if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
                Copy-Item -Path $_.FullName -Destination $destPath -Force
            }
        }
        Write-Host "✓ Updated tailcat/pkg/tailcat mirror" -ForegroundColor Green
    }
}
catch {
    Write-Warning "Local mirror update skipped ($($_)). The Go module is still fully updated."
}
finally {
    Remove-Item -Recurse -Force $tempCloneDir -ErrorAction SilentlyContinue
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
Write-Host "🎉 Tailcat successfully updated to: $version" -ForegroundColor Green
Write-Host "   Commit: $commitHash" -ForegroundColor Green
Write-Host "   Native Daemon: $outDaemon" -ForegroundColor Green
Write-Host "   WASM Asset:    $outWasmGz" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
