# Fleta + UTM 后台

## 项目结构

```
codex电商/
├── server.mjs       # Express 后端(静态服务 + UTM 跟踪 + 用户系统 + 管理后台)
├── package.json
├── render.yaml      # Render.com 一键部署配置
├── Dockerfile       # 通用 Docker 部署
├── vercel.json      # Vercel 部署配置
├── start.ps1        # 本地一键启动(Windows)
├── publish.ps1      # 一键发布到 Render(需联网 + gh 已登录)
├── public/
│   ├── index.html   # 抖音落地页(含 UTM 跟踪 + 注册/登录弹窗)
│   ├── admin.html   # UTM 后台仪表盘
│   ├── account.html # 用户账户页
│   ├── ecopulse.html      # 电商脉搏:全球电商政策/活动/热点大图轮播页
│   ├── ecopulse-data.js   # 电商脉搏数据源(资讯 + 配图路径)
│   └── ecopulse/          # 资讯配图(从各新闻页下载,图文一一配套)
├── scripts/
│   └── ecopulse-refresh.mjs  # 抓取最新资讯与配图,自动写回数据源
└── data/            # 运行时生成(users.json / db.json / events.json),已被 .gitignore 排除
```

## 本地运行

```bash
npm install
node server.mjs
# 访问 http://localhost:8080
# 后台:http://localhost:8080/admin/?token=codex2026
#   (若用 start.ps1 启动,默认 token 为 admin123)
```

## 永久部署(任选一种)

### 方案 A · Surge.sh(最简单,5 分钟搞定)

```bash
npm install -g surge
surge login   # 用你的邮箱注册
surge ./public your-name.surge.sh
# 永久链接:https://your-name.surge.sh
```

### 方案 B · Render.com(全栈,免费)

1. 把这个目录推到 GitHub
2. 登录 render.com → New Web Service → 连 GitHub
3. Render 会自动读 render.yaml 部署
4. 永久链接:https://你的项目名.onrender.com

### 方案 C · 自己的服务器 / NAS

```bash
docker build -t tracker .
docker run -d -p 8080:8080 \
  -e ADMIN_PASSWORD=你的密码 \
  -e SESSION_SECRET=随机字符串 \
  --name tracker \
  --restart always \
  tracker
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口,默认 8080 |
| `ADMIN_PASSWORD` | 是 | 后台登录密码 |
| `SESSION_SECRET` | 是 | cookie 签名密钥 |
| `PUBLIC_URL` | 否 | 用于后台展示 |

## UTM 参数说明

链接模板:
```
https://你的域名/?utm_source=douyin&utm_medium=video&utm_campaign=fleta_ai&utm_content=v1
```

| 参数 | 含义 | 示例 |
|---|---|---|
| utm_source | 来源 | douyin / kuaishou / xiaohongshu |
| utm_medium | 媒介 | video / live / bio / story |
| utm_campaign | 活动 | fleta_ai_v1 / q3_launch |
| utm_content | 内容 | 60s_hero / 30s_lite |
| utm_term | 关键词(选填) | amazon / tiktok |

## 数据存储

数据保存在 `app/data/db.json`,纯 JSON 文件,无外部依赖。
建议部署时挂载持久卷,避免重启丢数据。

## 电商脉搏(/ecopulse)

国内外电商平台的政策调整、活动计划与每日热点,全屏大图轮播(Ken Burns 动效),左下角显示事件的**日期 / 时间 / 内容摘要**,点击大图或「阅读原文」跳转新闻源页面。

- 页面:`public/ecopulse.html`,首页导航栏已加「电商脉搏」入口
- 数据:`public/ecopulse-data.js`(每条资讯的 `image` 都指向 `public/ecopulse/` 下从对应新闻页下载的配图)
- 分类:全部 / 每日热点 / 平台政策 / 海外跨境 / 活动计划,支持箭头、缩略图、键盘、滑动切换与自动播放

刷新资讯(抓取电商派 + 雨果跨境最新文章,连同配图一起下载并按 url 去重):

```bash
npm run refresh:ecopulse          # 每个源最多新增 8 条
node scripts/ecopulse-refresh.mjs --max=5   # 自定义每个源的新增上限
```

数据最多保留 40 条,手写条目与「大促倒计时」配置会完整保留。
