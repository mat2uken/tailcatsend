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
$webrtcPatchFile = Join-Path $TailcatDir "patches\0002-tailscale-webrtc-transport.patch"

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

}
finally {
    Pop-Location
}

function Apply-Patch {
    param(
        [string]$Checkout,
        [string]$Patch
    )
    if (-not (Test-Path $Patch)) { return }
    git -C $Checkout apply --check --unidiff-zero $Patch 2>$null
    if ($LASTEXITCODE -eq 0) {
        git -C $Checkout apply --unidiff-zero $Patch
        Write-Host "✓ Applied local patch: $(Split-Path $Patch -Leaf)" -ForegroundColor Green
        return
    }
    git -C $Checkout apply --reverse --check --unidiff-zero $Patch 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Local patch already applied: $(Split-Path $Patch -Leaf)" -ForegroundColor Green
        return
    }
    throw "Cannot apply patch $(Split-Path $Patch -Leaf) cleanly to $Checkout"
}

Apply-Patch (Join-Path $TailcatDir "pkg\tailcat") $patchFile
Apply-Patch (Join-Path $TailcatDir "pkg\tailscale.com") $webrtcPatchFile

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
        $newContent = $content -replace '(?m)^commit=[0-9a-f]+', "commit=$fullCommit"
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

    & $goExe build -tags tailcat_daemon -ldflags "-s -w" -o $outDaemon ./bridge/native
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

    $wasmTags = (Get-Content (Join-Path $TailcatDir "wasm-build-tags.txt") -Raw).Trim()

    & $goExe build -trimpath -tags $wasmTags -ldflags "-s -w" -o $outWasm ./bridge/web/main.go
    if ($LASTEXITCODE -ne 0) { throw "WASM build failed" }

    Write-Host "Optimizing WASM with wasm-opt -Oz..." -ForegroundColor Yellow
    & npx wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext $outWasm -o $outWasm
    if ($LASTEXITCODE -ne 0) { throw "wasm-opt optimization failed" }

    $rawBytes = [System.IO.File]::ReadAllBytes($outWasm)
    $fs = [System.IO.File]::Create($outWasmGz)
    $gzStream = [System.IO.Compression.GZipStream]::new($fs, [System.IO.Compression.CompressionLevel]::Optimal)
    $gzStream.Write($rawBytes, 0, $rawBytes.Length)
    $gzStream.Dispose()
    $fs.Dispose()

    $rawMB = [math]::Round($rawBytes.Length / 1MB, 2)
    $gzMB = [math]::Round((Get-Item $outWasmGz).Length / 1MB, 2)
    Write-Host "✓ Built and optimized tailcat.wasm: $rawMB MB (Gzip: $gzMB MB)" -ForegroundColor Green

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
Write-Host "`n[5/5] Running Tailcat bridge verification tests..." -ForegroundColor Yellow
Push-Location $TailcatDir
try {
    & $goExe test -v -timeout 120s .\bridge\native .\bridge\transportpath
    if ($LASTEXITCODE -ne 0) { throw "Native bridge tests failed" }
    $wasmTest = Join-Path ([System.IO.Path]::GetTempPath()) "tailcat-bridge-test-$PID.wasm"
    $env:GOOS = "js"
    $env:GOARCH = "wasm"
    & $goExe test -c -o $wasmTest .\bridge\web
    if ($LASTEXITCODE -ne 0) { throw "WebAssembly bridge test build failed" }
    Remove-Item -Force $wasmTest -ErrorAction SilentlyContinue
    Write-Host "✓ Integration test passed!" -ForegroundColor Green
}
finally {
    $env:GOOS = ""
    $env:GOARCH = ""
    Pop-Location
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "🎉 Tailcat successfully updated!" -ForegroundColor Green
Write-Host "   Submodule Commit: $commitHash ($fullCommit)" -ForegroundColor Green
Write-Host "   Native Daemon:    $outDaemon" -ForegroundColor Green
Write-Host "   WASM Asset:       $outWasmGz" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
