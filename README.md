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
│   └── account.html # 用户账户页
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
