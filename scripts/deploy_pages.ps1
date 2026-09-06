# Deploy TailSend Web to Cloudflare Pages
$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $ProjectRoot

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host "   Deploying TailSend Web Client to Cloudflare Pages     " -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Cyan

if (-not (Test-Path "$ProjectRoot\dist\index.html")) {
    throw "dist/index.html not found! Please ensure dist is built."
}

Write-Host "Deploying dist/ directory to project 'mktailcatsend'..." -ForegroundColor Yellow
$rawWasmPath = "$ProjectRoot\dist\pkg\tailsend_web_bg.wasm"
$tempWasmPath = "$ProjectRoot\target\tailsend_web_bg.wasm"
$hasRawWasm = Test-Path $rawWasmPath

try {
    if ($hasRawWasm) {
        Move-Item -Path $rawWasmPath -Destination $tempWasmPath -Force
    }
    npx wrangler pages deploy dist --project-name mktailcatsend --commit-dirty=true
}
finally {
    if ($hasRawWasm -and (Test-Path $tempWasmPath)) {
        Move-Item -Path $tempWasmPath -Destination $rawWasmPath -Force
    }
}

Write-Host "`n✅ Cloudflare Pages Deployment Complete!" -ForegroundColor Green
Write-Host "Live URL: https://mktailcatsend.pages.dev" -ForegroundColor Green
Write-Host "========================================================`n" -ForegroundColor Cyan
