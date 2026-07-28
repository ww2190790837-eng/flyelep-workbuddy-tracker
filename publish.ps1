# 一键发布脚本
# 用法:.\publish.ps1 -Message "改了什么"

param(
  [Parameter(Mandatory=$true)]
  [string]$Message,

  [string]$Remote = "origin",
  [string]$Branch = "master",
  [int]$WaitRenderSec = 60
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$gh = Join-Path $root "gh-tool\bin\gh.exe"
$token = & $gh auth token 2>$null
$pushUrl = "https://x-access-token:$token@github.com/ww2190790837-eng/flyelep-workbuddy-tracker.git"

function Ok($m){ Write-Host "✅ $m" -ForegroundColor Green }
function Warn($m){ Write-Host "⚠️  $m" -ForegroundColor Yellow }
function Info($m){ Write-Host "ℹ️  $m" -ForegroundColor Cyan }
function Err($m){ Write-Host "❌ $m" -ForegroundColor Red; exit 1 }

# 1. 检查改动
Info "检查文件改动..."
$status = git status --short
if (-not $status) { Warn "没有改动,跳过"; exit 0 }
Write-Host $status
Write-Host ""
$confirm = Read-Host "👉 改的就是这些?回车继续"
Info "继续..."

# 2. add + commit
git add -A
git -c user.email="[email protected]" -c user.name="ww2190790837-eng" commit -m $Message
if ($LASTEXITCODE -ne 0) { Err "commit 失败" }
Ok "commit 成功"

# 3. push(用 token 走 URL,绕开 credential helper 空格问题)
Info "git push..."
$env:GIT_TERMINAL_PROMPT = "0"  # 禁用交互
git push $pushUrl $Branch 2>&1
if ($LASTEXITCODE -ne 0) { Err "push 失败" }
Ok "push 成功"

# 4. 触发 Render 部署
$renderToken = "rnd_H6TaIL4ZEBtBvZPfSJhrNdisxugY"
$serviceId = "srv-d9k5uvnavr4c73a97rrg"
$apiBase = "https://api.render.com/v1"
$hdr = @{ "Authorization" = "Bearer $renderToken"; "Content-Type" = "application/json"; "Accept" = "application/json" }

$trigger = Invoke-RestMethod -Uri "$apiBase/services/$serviceId/deploys" -Method POST -Headers $hdr -Body "{}" -TimeoutSec 30
$deployId = $trigger.id
Ok "Render 部署已触发: $deployId"

# 5. 轮询
$elapsed = 0
$poll = 5
while ($elapsed -lt $WaitRenderSec) {
  Start-Sleep -Seconds $poll
  $elapsed += $poll
  try {
    $d = Invoke-RestMethod -Uri "$apiBase/services/$serviceId/deploys?limit=1" -Headers $hdr -TimeoutSec 30
    $s = $d[0].deploy.status
    Info "(${elapsed}s) 状态: $s"
    if ($s -eq "live") { break }
    if ($s -eq "build_failed" -or $s -eq "update_failed" -or $s -eq "canceled") {
      Err "部署失败!去 https://dashboard.render.com 看日志"
    }
  } catch {
    Warn "查询状态失败(可能限流),稍后去 dashboard 看"
  }
}

# 6. 验证
Write-Host ""
$publicUrl = "https://flyelep-wb-tracker.onrender.com"
try {
  $r = Invoke-WebRequest -Uri "$publicUrl/healthz" -UseBasicParsing -TimeoutSec 60
  if ($r.StatusCode -eq 200) {
    Ok "新版本已上线!"
    Write-Host ""
    Write-Host "🌐 落地页:   $publicUrl" -ForegroundColor Cyan
    Write-Host "🔧 后台:     $publicUrl/admin/?token=codex2026" -ForegroundColor Cyan
  }
} catch {
  Warn "健康检查超时(冷启动中),30 秒后再试"
}
