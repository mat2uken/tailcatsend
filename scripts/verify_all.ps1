# TailSend Comprehensive Multi-Layer Verification Runner
$ErrorActionPreference = "Stop"

$goPath = "$HOME\go\bin"
if (Test-Path $goPath) {
    $env:PATH = "$goPath;" + $env:PATH
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     TailSend (Tailcat + Slint) Automated Verification     " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$results = [System.Collections.Generic.List[PSCustomObject]]::new()

function Measure-Step {
    param(
        [string]$Name,
        [scriptblock]$Block
    )
    Write-Host "`n>>> Running: $Name..." -ForegroundColor Yellow
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Block
        $sw.Stop()
        Write-Host "✓ $Name PASSED ($([math]::Round($sw.Elapsed.TotalSeconds, 2))s)" -ForegroundColor Green
        $results.Add([PSCustomObject]@{
            Step = $Name
            Status = "PASSED"
            DurationSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
            Details = "OK"
        })
    }
    catch {
        $sw.Stop()
        Write-Host "✗ $Name FAILED ($([math]::Round($sw.Elapsed.TotalSeconds, 2))s): $_" -ForegroundColor Red
        $results.Add([PSCustomObject]@{
            Step = $Name
            Status = "FAILED"
            DurationSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
            Details = $_.ToString()
        })
    }
}

# Step 1: Rust Workspace Tests
Measure-Step "1. Rust Unit & Integration Tests (cargo test --workspace)" {
    cargo test --workspace
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed with exit code $LASTEXITCODE" }
}

# Step 2: Web WASM Target Check
Measure-Step "2. WebAssembly Target Verification (wasm32-unknown-unknown)" {
    cargo check --target wasm32-unknown-unknown -p tailsend-web
    if ($LASTEXITCODE -ne 0) { throw "wasm32 check failed with exit code $LASTEXITCODE" }
}

# Step 3: Go Tailcat Bridge & DERP Relay Test
Measure-Step "3. Tailcat WireGuard & DERP Relay Integration (go test)" {
    Push-Location "tailcat"
    try {
        go test -v -timeout 120s .\bridge\web\bridge_test.go
        if ($LASTEXITCODE -ne 0) { throw "go test failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

# Step 4: Web Static Assets Gzip Size & Cloudflare Limits
Measure-Step "4. Cloudflare 25MB Limit & Static Assets Verification" {
    $tailcatGz = Get-Item "dist\assets\tailcat.wasm.gz"
    $slintGz = Get-Item "dist\pkg\tailsend_web_bg.wasm.gz"

    $tailcatMB = [math]::Round($tailcatGz.Length / 1MB, 2)
    $slintMB = [math]::Round($slintGz.Length / 1MB, 2)

    Write-Host "   - tailcat.wasm.gz: $tailcatMB MB (Max allowed: 25 MB)" -ForegroundColor Gray
    Write-Host "   - tailsend_web_bg.wasm.gz: $slintMB MB (Max allowed: 25 MB)" -ForegroundColor Gray

    if ($tailcatGz.Length -gt 25MB) { throw "tailcat.wasm.gz exceeds 25MB limit" }
    if ($slintGz.Length -gt 25MB) { throw "tailsend_web_bg.wasm.gz exceeds 25MB limit" }
}

# Step 5: Headless Browser E2E Runner
Measure-Step "5. Headless Browser E2E (WASM decompression + runtime)" {
    node tests\e2e\run_e2e.js
    if ($LASTEXITCODE -ne 0) { throw "E2E runner failed with exit code $LASTEXITCODE" }
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "                 Final Verification Summary                " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
$results | Format-Table -AutoSize

$failedCount = ($results | Where-Object { $_.Status -eq "FAILED" }).Count
if ($failedCount -eq 0) {
    Write-Host "🎉 ALL $(${results}.Count) VERIFICATION GATES PASSED CLEANLY!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "❌ $failedCount STEP(S) FAILED. Please review the log above." -ForegroundColor Red
    exit 1
}
