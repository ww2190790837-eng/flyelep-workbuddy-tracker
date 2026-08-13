# Fleta × WorkBuddy Tracker 启动脚本
# 用法:右键以 PowerShell 运行,或者 .\start.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "=== Fleta × WorkBuddy Tracker ===" -ForegroundColor Cyan
Write-Host "工作目录: $root"

# 检查 Node
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Host "❌ 未检测到 node,请先安装 Node.js 18+" -ForegroundColor Red
  exit 1
}
Write-Host "✅ Node $($node.Version)"

# 检查依赖
if (-not (Test-Path "node_modules")) {
  Write-Host "📦 安装依赖..." -ForegroundColor Yellow
  & npm install
}

# 默认密码
if (-not $env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD = "admin123" }
if (-not $env:SESSION_SECRET) { $env:SESSION_SECRET = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object {[char]$_}) }

# 端口
$port = if ($env:PORT) { $env:PORT } else { 8080 }

# 杀掉旧进程
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*node.exe" } | ForEach-Object {
  try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "🚀 启动服务..." -ForegroundColor Green
Write-Host "   落地页:    http://localhost:$port/" -ForegroundColor White
Write-Host "   后台:      http://localhost:$port/admin/?token=$env:ADMIN_PASSWORD" -ForegroundColor White
Write-Host "   健康检查:  http://localhost:$port/healthz" -ForegroundColor Gray
Write-Host ""
Write-Host "按 Ctrl+C 退出" -ForegroundColor Yellow
Write-Host ""

& node server.mjs
