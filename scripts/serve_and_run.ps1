# TailSend Mobile & Local Verification Launcher
$ErrorActionPreference = "Stop"

# 1. Detect LAN IP
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { 
    $_.InterfaceAlias -notlike "*Loopback*" -and 
    $_.IPAddress -notlike "169.254.*" -and 
    $_.IPAddress -notlike "100.*" 
} | Select-Object -First 1).IPAddress

if (-not $lanIP) {
    $lanIP = "192.168.99.186"
}

$port = 8787
$baseUrl = "http://${lanIP}:${port}"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     TailSend (Tailcat + Slint) Mobile Verification       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Detected PC LAN IP: $lanIP" -ForegroundColor Green
Write-Host "Web Base URL:       $baseUrl" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

# 2. Start Local Node.js Web Server in Background
Write-Host "`n>>> Starting local HTTP server at $baseUrl..." -ForegroundColor Yellow
$serverProcess = Start-Process node -ArgumentList "scripts\server.js" -PassThru -NoNewWindow

Start-Sleep -Seconds 1

# 3. Launch TailSend Desktop App
Write-Host "`n>>> Launching TailSend Desktop Host with Base URL: $baseUrl..." -ForegroundColor Yellow
Write-Host "`n【操作手順】" -ForegroundColor Cyan
Write-Host "1. PC上にTailSendアプリのウィンドウが開き、QRコードが表示されます。" -ForegroundColor White
Write-Host "2. スマホの標準カメラアプリで画面のQRコードを読み取ってください。" -ForegroundColor White
Write-Host "   （またはスマホのブラウザで上記URLにアクセス）" -ForegroundColor Gray
Write-Host "3. スマホのブラウザでWeb版が起動し、自動的にPCと接続されます。" -ForegroundColor White
Write-Host "4. テキスト送信やファイル送信をお試しください。" -ForegroundColor White
Write-Host "`n※ 終了する時は、このウィンドウで Ctrl+C を押して終了してください。`n" -ForegroundColor DarkGray

try {
    & ".\target\debug\tailsend.exe" $baseUrl
}
finally {
    Write-Host "`n>>> Stopping local web server..." -ForegroundColor Yellow
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✓ Web server stopped." -ForegroundColor Green
}
