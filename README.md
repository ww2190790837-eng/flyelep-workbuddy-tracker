# Fleta — 抖音引流落地页 + 用户系统 + UTM 后台 + AI 工具

集成了 UTM 跟踪后台、邮箱验证码用户系统，以及若干 AI 创作工具（提示词生成、视频反推、Agnes 视频生成）。

线上地址：<https://flyelep-wb-tracker.onrender.com>

## 首页功能

顶部导航（均为**页内锚点滚动**，不跳独立页）：`提示词` / `视频反推` / `Agnes 视频` / `联系我`

- **AI 视频提示词生成器**：五段式结构（主体 + 风格 + 时间线 + BGM + 限制），支持「一句话描述 + 上传参考图」，    
  由 LLM 生成专业提示词（默认 `glm-4-air`，LLM 不可用时回退本地模板）。生成记录匿名入库用于持续训练。
- **视频反推**：上传视频 → 自动抽帧 → AI 反推完整五段式提示词。
- **Agnes 视频生成**（Agnes Video 2.5 Flash）：三模式 —— 文生视频 / 首尾帧控制 / 图片参考生成。    
  首帧、尾帧、参考图片、参考音频均为**本地上传**（服务端托管为公开 URL 后交给 Agnes）。
- **留言板**、**免费积分邀请码**、**用户系统**（邮箱验证码注册/登录，支持自定义头像与昵称）。

全站共用一套**固定满屏动态背景**（光团 + 动态 Canvas + 网格 + 噪点），滚动时不动。

## 项目结构

```
codex电商/
├── server.mjs            # Express 后端（静态服务 + 用户系统 + UTM 跟踪 + AI 代理 + 管理后台）
├── package.json
├── render.yaml           # Render.com 部署配置
├── Dockerfile            # 通用 Docker 部署
├── vercel.json           # Vercel 部署配置
├── start.ps1             # 本地一键启动（Windows）
├── publish.ps1           # 旧发布脚本（git push 已失效，见「部署」）
├── scripts/
│   └── ghpush.mjs        # 一键发布：走 GitHub Git Data API 推代码并触发 Render 部署
├── public/
│   ├── index.html        # 落地页（导航 / 提示词 / 视频反推 / Agnes 视频 / 留言板 / 登录弹窗）
│   ├── login.html        # 登录页
│   ├── settings.html     # 账户设置（头像 / 昵称 / 改密）
│   ├── account.html      # 旧账户页（已重定向回首页，保留兼容）
│   ├── admin.html        # UTM 后台仪表盘（token 登录）
│   ├── admin-login.html  # 后台登录页
│   ├── motion.js         # 高级动效层（Lenis 平滑滚动 + GSAP 时间轴 + WebGL 颗粒层 + 预加载 + 光标）
│   ├── vendor/           # 本地内置动效库（无外链依赖，避免 CDN 不可用）
│   │   ├── gsap.min.js / ScrollTrigger.min.js / SplitText.min.js
│   │   └── lenis.min.js
│   └── logo.* / wechat-qr.png ...
│   # 说明：动态背景已改为「纯 CSS/SVG/WebGL 轻量层」，内联在 index.html / login.html 中，
│   #      原 bg-home.js（逐帧重绘 Canvas）与 bg-aurora.js（O(n²) 粒子连线）已删除。

## 前端动效栈（v1.4.0）

- **视觉**：近单色黑白 + 冷光（HUD/军工风），锐角、细线框、双语导航、巨幅字标、技术线稿背景。
- **动效**：`public/motion.js` + `public/vendor/`（本地内置，不走 CDN）
  - **Lenis** 平滑惯性滚动（`lenis.on('scroll', ScrollTrigger.update)`，由 `gsap.ticker` 驱动）
  - **GSAP + ScrollTrigger**：开屏加载计数、字标 SplitText 逐字入场、`.reveal` 批量揭示、章节大编号视差
  - **WebGL 片元着色器**：细网格 / 扫描线 / 横向扫光 / 鼠标补光 / 颗粒（约 30fps，`mix-blend-mode:screen` 叠加）
- **性能纪律**：只动 `transform` / `opacity`；`backdrop-filter` 全站禁用；
  颗粒层 DPR ≤ 1.5；隐藏页暂停；`prefers-reduced-motion` 时整体降级为静态。
- **降级安全**：脚本/库缺失时不会白屏——内容默认可见，只有拿到库才加 `.motion-ready` 隐藏待入场元素。
- **配套技能**：`web-motion-design`（来自 GitHub `dylantarre/animation-principles`），随项目存放于
  `.workbuddy/skills/web-motion-design/`（同时也在用户级 `~/.workbuddy/skills/`）。
└── data/                 # 运行时生成（users.json / db.json 等），已被 .gitignore 排除
```

## 本地运行

```bash
npm install
node server.mjs
# 访问 http://localhost:8080
# 后台 http://localhost:8080/admin/?token=codex2026
#   （若用 start.ps1 启动，默认 token 为 admin123）
```

## 部署

主部署在 **Render.com**（服务 `srv-d9k5uvnavr4c73a97rrg`）。

一键发布（**推荐**）：

```bash
git add -A && git commit -m "说明"
node scripts/ghpush.mjs "说明"
```

`ghpush.mjs` 通过 GitHub Git Data API（`api.github.com`）推送并自动触发 Render 部署。  
⚠️ 不要用 `git push` / `publish.ps1`——本机到 `github.com:443` 不通，会超时失败。

## 环境变量

| 变量                                                       | 必填 | 默认          | 说明                                      |
| -------------------------------------------------------- | -- | ----------- | --------------------------------------- |
| `PORT`                                                   | 否  | `8080`      | 监听端口                                    |
| `ADMIN_PASSWORD`                                         | 否  | `codex2026` | 后台登录 token                              |
| `SESSION_SECRET`                                         | 否  | —           | session 签名密钥                            |
| `USERS_GIST_TOKEN` / `USERS_GIST_ID`                     | 否  | —           | 用户数据存 GitHub 私有 Gist（跨设备/重启不丢，**线上默认**） |
| `MONGODB_URI`                                            | 否  | —           | 若配置则优先用 MongoDB Atlas                   |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`                | 否  | —           | 提示词生成所用 LLM                             |
| `AGNES_API_KEY` / `AGNES_BASE_URL` / `AGNES_VIDEO_MODEL` | 否  | —           | Agnes 视频生成（默认 `agnes-video-2.5-flash`）  |

> ⚠️ 该服务由 `render.yaml`（Blueprint）托管，**自定义环境变量不会自动注入**；>   
> 因此需要的配置都在 `server.mjs` 里写了硬编码兜底，可用环境变量覆盖。

## 数据存储

- 用户数据：GitHub 私有 Gist 优先，其次 MongoDB，最后本地 JSON（`data/users.json`，重启会丢）。
- 留言板 / 提示词语料 / UTM 跟踪 / 邀请码：Gist + 本地 JSON 兜底。
- 头像以 base64 data URL 存在用户文档中（不落文件）。
- Agnes 上传的素材临时落在 `public/uploads/`（运行时生成，已被 `.gitignore` 排除）。

## 后台

`/admin/?token=<ADMIN_PASSWORD>`：查看 PV/点击、UTM 来源分布、用户列表、邀请码库存、  
提示词语料，支持导出 CSV 与重置。

## UTM 参数

链接模板：

```
https://你的域名/?utm_source=douyin&utm_medium=video&utm_campaign=fleta_ai&utm_content=v1
```

| 参数           | 含义      | 示例                              |
| ------------ | ------- | ------------------------------- |
| utm_source   | 来源      | douyin / kuaishou / xiaohongshu |
| utm_medium   | 媒介      | video / live / bio / story      |
| utm_campaign | 活动      | fleta_ai_v1 / q3_launch         |
| utm_content  | 内容      | 60s_hero / 30s_lite             |
| utm_term     | 关键词（选填） | amazon / tiktok                 |

## 历史 / 已删除的功能

- 文稿工作室 `/studio`、智能体技能库 `/skills`（含旧 `/ecopulse`）、Slidev 演示文稿 `/slides` 三个功能已**完整删除**（页面、路由、数据、脚本，含仓库外的 Slidev 源码）。    
  旧链接 `/agnes-video` 仍保留 302 跳转到 `/#agnes-video` 作兼容。
- 早期文档提到的「电商脉搏 / ecopulse」页面已不存在。
