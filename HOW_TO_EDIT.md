# 怎么改网站 + 怎么同步上线

> 整个网站就两个核心文件,改完用 `publish.ps1` 一键同步到 Render。

## 📁 改哪里

| 想改什么 | 改这个文件 | 备注 |
|---|---|---|
| 落地页文案/图片/按钮 | `public/index.html` | 单文件,所有 HTML+CSS+JS 都在里面 |
| 后台仪表盘 | `public/admin.html` | 一般不用改 |
| 跟踪逻辑/统计/接口 | `server.mjs` | 改完要重启服务 |
| 部署配置 | `render.yaml` | 一般不用改 |
| 依赖 | `package.json` | 加新包后要重装 |

### 落地页长这样 👇

`public/index.html` 结构(用编辑器搜这些关键字定位):

```
顶部 banner  → 搜:抖音评论区专属入口
品牌名      → 搜:Fleta / 腾讯 WorkBuddy
主标题      → 搜:h1 (一个管"脸面"...)
痛点板块    → 搜:pain-item
平台徽章    → 搜:platforms
适用人群    → 搜:who-card
FAQ 问答    → 搜:faq-item
终极 CTA    → 搜:final-cta
跟踪代码    → 搜:utm_source (页面底部)
```

> 💡 推荐用 **VS Code** 打开 `public/index.html`,Ctrl+F 定位,改完 Ctrl+S 保存

## 🔄 改完怎么同步

### 最简单:跑一个命令

```powershell
.\publish.ps1 -Message "把 hero 标题改成 XX"
```

它会自动:
1. ✅ git add + commit(用你给的消息)
2. ✅ git push 到 GitHub
3. ✅ 触发 Render 重新部署
4. ✅ 等部署完成(最多 60 秒)
5. ✅ 验证新版本能访问
6. ✅ 打印新的链接

### 改完跑一次就这样

```
✅ commit 成功
✅ push 成功
(30s) 状态: live
✅ 新版本已上线!
🌐 https://fleta-ai.onrender.com
```

## 🛠 常用操作速查

### 1. 改文案(最常见)
- 用 VS Code 打开 `public/index.html`
- Ctrl+F 找到要改的字
- 改完 Ctrl+S
- 跑 `.\publish.ps1 -Message "改 hero"`

### 2. 加一个新的 CTA 按钮
- 在 `public/index.html` 找一个 `.cta-row` 复制粘贴
- 改文案、链接、颜色
- publish

### 3. 改后台密码
- 浏览器打开 [https://dashboard.render.com/web/srv-d9k5uvnavr4c73a97rrg/env](https://dashboard.render.com/web/srv-d9k5uvnavr4c73a97rrg/env)
- 找到 `ADMIN_PASSWORD` → Edit → 改成新密码 → Save
- Render 会自动重启服务,新密码立即生效

### 4. 加新的 UTM 维度
- 编辑 `public/index.html` 底部的 JS 跟踪代码
- 编辑 `server.mjs` 的 `getUtm()` 函数
- publish

### 5. 看数据
- 打开 [https://fleta-ai.onrender.com/admin/?token=codex2026](https://fleta-ai.onrender.com/admin/?token=codex2026)
- 或访问 `/admin/api/export.csv?token=codex2026` 下载完整 CSV

## ⚠️ 不要改的地方

- `.git/` (git 内部)
- `gh-tool/` (gh CLI 工具,改了你就没法 push 了)
- `node_modules/` (依赖,已经被 .gitignore 排除)

## 🆘 推不上去怎么办

```powershell
# 看 gh 是否还登录
.\gh-tool\bin\gh.exe auth status

# 重新登录
.\gh-tool\bin\gh.exe auth login --web
```

## 🔗 所有链接

| | 链接 |
|---|---|
| 落地页 | https://fleta-ai.onrender.com |
| 带 UTM 模板 | https://fleta-ai.onrender.com/?utm_source=douyin&utm_medium=video&utm_campaign=fleta_ai&utm_content=v1 |
| 后台 | https://fleta-ai.onrender.com/admin/?token=codex2026 |
| 后台 API | https://fleta-ai.onrender.com/admin/api/stats?token=codex2026 |
| 健康检查 | https://fleta-ai.onrender.com/healthz |
| Render 控制台 | https://dashboard.render.com/web/srv-d9k5uvnavr4c73a97rrg |
| GitHub 仓库 | https://github.com/ww2190790837-eng/flyelep-workbuddy-tracker |
