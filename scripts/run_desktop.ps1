# TailSend Cloudflare-backed Real Tailcat Desktop Launcher
$ErrorActionPreference = "Stop"

$cloudflareUrl = "https://ponlet.mat2uken.app"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     TailSend (Tailcat + Slint) Cloudflare P2P Host       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Cloudflare Pages: $cloudflareUrl" -ForegroundColor Green
Write-Host "Tailcat DERP:     https://tailcat.dev/derpmap.json" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

Write-Host "`n>>> Starting TailSend Native Desktop Host..." -ForegroundColor Yellow
Write-Host ""
Write-Host "1. PC上にTailSendアプリのウィンドウが開き、Cloudflare連携QRコードが表示されます。" -ForegroundColor White
Write-Host "2. スマホ（4G/5G携帯回線・別Wi-Fi・どこからでも可）のカメラでQRコードをスキャンしてください。" -ForegroundColor White
Write-Host "3. スマホのブラウザでWeb版がCloudflareから高速読み込みされ、DERPリレー経由でPCと直接WireGuard P2P接続されます。" -ForegroundColor White
Write-Host "4. テキスト送信やファイル送信をお試しください。" -ForegroundColor White
Write-Host ""

# 起動引数なしでも暗黙的に ponlet.mat2uken.app が使用されます
& ".\target\release\tailsend.exe"
