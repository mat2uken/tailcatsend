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
$rawSlintWasm = "$ProjectRoot\dist\pkg\tailsend_web_bg.wasm"
$tempSlintWasm = "$ProjectRoot\target\tailsend_web_bg.wasm"
$hasSlintWasm = Test-Path $rawSlintWasm

$rawTailcatWasm = "$ProjectRoot\dist\assets\tailcat.wasm"
$tempTailcatWasm = "$ProjectRoot\target\tailcat.wasm"
$hasTailcatWasm = Test-Path $rawTailcatWasm

try {
    if ($hasSlintWasm) {
        Move-Item -Path $rawSlintWasm -Destination $tempSlintWasm -Force
    }
    if ($hasTailcatWasm) {
        Move-Item -Path $rawTailcatWasm -Destination $tempTailcatWasm -Force
    }
    npx wrangler pages deploy dist --project-name mktailcatsend --commit-dirty=true
}
finally {
    if ($hasSlintWasm -and (Test-Path $tempSlintWasm)) {
        Move-Item -Path $tempSlintWasm -Destination $rawSlintWasm -Force
    }
    if ($hasTailcatWasm -and (Test-Path $tempTailcatWasm)) {
        Move-Item -Path $tempTailcatWasm -Destination $rawTailcatWasm -Force
    }
}

Write-Host "`n✅ Cloudflare Pages Deployment Complete!" -ForegroundColor Green
Write-Host "Live URL: https://ponlet.mat2uken.app" -ForegroundColor Green
Write-Host "========================================================`n" -ForegroundColor Cyan
