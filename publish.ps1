# 一键发布脚本
# 用法:.\publish.ps1 -Message "改了什么"
# 作用:git add → commit → push → 等 Render 部署 → 给出新链接

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

# 颜色
function Ok($m){ Write-Host "✅ $m" -ForegroundColor Green }
function Warn($m){ Write-Host "⚠️  $m" -ForegroundColor Yellow }
function Info($m){ Write-Host "ℹ️  $m" -ForegroundColor Cyan }
function Err($m){ Write-Host "❌ $m" -ForegroundColor Red; exit 1 }

# 0. 检查 git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Err "找不到 git,请先安装 Git for Windows"
}

# 1. 检查改动
Info "检查文件改动..."
$status = git status --short
if (-not $status) {
  Warn "没有改动,跳过 commit/push"
  exit 0
}
Write-Host $status

# 2. 让你确认改了什么
Write-Host ""
$confirm = Read-Host "👉 改的就是这些?回车继续,Ctrl+C 中断"
if ($confirm -ne "") {
  Warn "你输入了内容,已确认,继续"
}

# 3. add + commit
Info "git add + commit..."
git add -A
git -c user.email="[email protected]" -c user.name="ww2190790837-eng" commit -m $Message
if ($LASTEXITCODE -ne 0) { Err "commit 失败" }
Ok "commit 成功"

# 4. push
Info "git push..."
$token = & "$root\gh-tool\bin\gh.exe" auth token 2>$null
if ($token) {
  git remote set-url $Remote "https://x-access-token:$token@github.com/ww2190790837-eng/flyelep-workbuddy-tracker.git" 2>$null
}
git push $Remote $Branch 2>&1 | Tee-Object -FilePath "$root\.push.log" | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Err "push 失败" }
Ok "push 成功"

# 5. 触发 Render 部署(因为 autoDeploy=yes,通常 push 后 Render 自动检测)
Info "Render 检测到 push,通常会自动开始部署"
Info "等 ${WaitRenderSec}s 看部署结果..."

$renderToken = "rnd_H6TaIL4ZEBtBvZPfSJhrNdisxugY"
$serviceId = "srv-d9k5uvnavr4c73a97rrg"
$apiBase = "https://api.render.com/v1"

$headers = @{
  "Authorization" = "Bearer $renderToken"
  "Accept" = "application/json"
}

Start-Sleep -Seconds 5  # 给 Render 一点时间检测 push

# 获取最新部署
$deploy = Invoke-RestMethod -Uri "$apiBase/services/$serviceId/deploys?limit=1" -Headers $headers -TimeoutSec 30
$latest = $deploy[0].deploy
$status = $latest.status
Info "最新部署状态: $status"

if ($status -ne "live" -and $status -ne "build_in_progress" -and $status -ne "update_in_progress") {
  # 手动触发
  Warn "Render 没自动检测到,手动触发部署"
  $trigger = Invoke-RestMethod -Uri "$apiBase/services/$serviceId/deploys" -Method POST -Headers $headers -Body "{}" -ContentType "application/json" -TimeoutSec 30
  $deployId = $trigger.id
  Ok "手动部署已触发: $deployId"
} else {
  $deployId = $latest.id
  Ok "Render 已经在部署: $deployId"
}

# 6. 轮询等部署完成
$elapsed = 0
$poll = 5
while ($elapsed -lt $WaitRenderSec) {
  Start-Sleep -Seconds $poll
  $elapsed += $poll
  try {
    $d = Invoke-RestMethod -Uri "$apiBase/services/$serviceId/deploys?limit=1" -Headers $headers -TimeoutSec 30
    $s = $d[0].deploy.status
    Info "(${elapsed}s) 状态: $s"
    if ($s -eq "live") { break }
    if ($s -eq "build_failed" -or $s -eq "update_failed" -or $s -eq "canceled") {
      Err "部署失败!状态:$s,请去 https://dashboard.render.com 查看日志"
    }
  } catch {
    Warn "查询状态失败(可能 Render API 限流),稍后手动去 dashboard 看"
  }
}

# 7. 验证
Write-Host ""
Info "验证新版本..."
$publicUrl = "https://flyelep-wb-tracker.onrender.com"
try {
  $r = Invoke-WebRequest -Uri "$publicUrl/healthz" -UseBasicParsing -TimeoutSec 60
  if ($r.StatusCode -eq 200) {
    Ok "新版本已上线!"
    Write-Host ""
    Write-Host "🌐 落地页:   $publicUrl" -ForegroundColor Cyan
    Write-Host "🔧 后台:     $publicUrl/admin/?token=codex2026" -ForegroundColor Cyan
    Write-Host "📊 实时数据: $publicUrl/admin/api/stats (需登录)" -ForegroundColor Cyan
  } else {
    Warn "服务返回 $($r.StatusCode),去 dashboard 看详情"
  }
} catch {
  Warn "健康检查超时(可能在冷启动,30 秒后再试): $publicUrl"
}

Write-Host ""
Info "完事!🎉 抖音视频里直接换新链接就行"
