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

    $wasmTags = "netgo,omitidna,omitpemdecrypt,osusergo,ts_omit_ace,ts_omit_acme,ts_omit_advertiseexitnode,ts_omit_advertiseroutes,ts_omit_appconnectors,ts_omit_aws,ts_omit_bakedroots,ts_omit_bird,ts_omit_c2n,ts_omit_cachenetmap,ts_omit_captiveportal,ts_omit_capture,ts_omit_cliconndiag,ts_omit_clientmetrics,ts_omit_clientupdate,ts_omit_cloud,ts_omit_colorable,ts_omit_completion,ts_omit_completion_scripts,ts_omit_conn25,ts_omit_dbus,ts_omit_debug,ts_omit_debugeventbus,ts_omit_debugportmapper,ts_omit_desktop_sessions,ts_omit_dns,ts_omit_doctor,ts_omit_drive,ts_omit_favorites,ts_omit_flashappliance,ts_omit_gro,ts_omit_health,ts_omit_hujsonconf,ts_omit_identityfederation,ts_omit_ipnbus,ts_omit_iptables,ts_omit_kube,ts_omit_linkspeed,ts_omit_linuxdnsfight,ts_omit_listenrawdisco,ts_omit_logtail,ts_omit_netlog,ts_omit_networkmanager,ts_omit_oauthkey,ts_omit_osrouter,ts_omit_outboundproxy,ts_omit_peerapiclient,ts_omit_peerapiserver,ts_omit_portlist,ts_omit_portmapper,ts_omit_posture,ts_omit_qrcodes,ts_omit_relayserver,ts_omit_remoteconfig,ts_omit_resolved,ts_omit_routecheck,ts_omit_runtimemetrics,ts_omit_sdnotify,ts_omit_serve,ts_omit_serviceclientprefs,ts_omit_ssh,ts_omit_synology,ts_omit_syslog,ts_omit_syspolicy,ts_omit_systray,ts_omit_taildrop,ts_omit_tailnetlock,ts_omit_tap,ts_omit_tpm,ts_omit_tundevstats,ts_omit_unixsocketidentity,ts_omit_useexitnode,ts_omit_useproxy,ts_omit_usermetrics,ts_omit_useroutes,ts_omit_wakeonlan,ts_omit_webbrowser,ts_omit_webclient"

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
