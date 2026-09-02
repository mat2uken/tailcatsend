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

Write-Host "Deploying dist/ directory to project 'tailsend'..." -ForegroundColor Yellow
npx wrangler pages deploy dist --project-name tailsend --commit-dirty=true

Write-Host "`n✅ Cloudflare Pages Deployment Complete!" -ForegroundColor Green
Write-Host "Live URL: https://tailsend.pages.dev" -ForegroundColor Green
Write-Host "========================================================`n" -ForegroundColor Cyan
