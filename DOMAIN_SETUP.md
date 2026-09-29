# 🌐 域名绑定配置指南

> **当前状态**：站点运行在 Render 服务 `fleta-ai`（`srv-d9k5uvnavr4c73a97rrg`）。
> 默认地址 `flyelep-wb-tracker.onrender.com`；已登记自定义域名 **`fleta.abrdns.com`**，状态 `unverified`（等待 DNS 生效）。
> 站点内所有 SEO 字段（`canonical` / `og:url` / schema `url` / `logo` / 页脚官网链接）与 `PUBLIC_URL` 均已指向 `https://fleta.abrdns.com`。

## ⚠️ 换域名前必做：先核实域名归属

**不要**直接把 `canonical` / `og:url` / 页脚官网链接指向一个你尚未核实的域名 —— 如果那域名属于别人，等于把访客导去对方站点、并把自身 SEO 权重送给对方。

```bash
# 1) 看解析到哪、返回什么
nslookup 你的域名
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/
curl -sI https://你的域名/ | grep -i -E 'HTTP/|location|server'

# 2) 看是否已注册（.cn 用 whois 接口；RDAP 对 .cn 无服务）
curl -s "https://api.whois.vu/?q=你的域名"
```

真实案例：
- `fleta.com` → 属第三方（西班牙 Plásticos Fleta 在跑 WordPress，解析 `178.211.133.54`）→ **不能指**
- `fleta.cn` → whois 显示 `available: yes`，DNS 无解析 → **未被占用**
- `fleta.abrdns.com` → 已在 abrdns 的 DNS 面板建好区域，可解析（指向 abrdns 默认 IP）→ **可用**

## ✅ 绑定步骤

### 步骤 1 · 在 Render 登记自定义域名

1. 打开 https://dashboard.render.com/web/srv-d9k5uvnavr4c73a97rrg/settings
2. 左侧 **Custom Domains** → **+ Add Custom Domain**
3. 输入域名 → **Save**
   - 遇到 `This domain is in use on your service "xxx"` → 说明该域名还绑在**另一个** Render 服务上，需先去那边删掉（注意核对服务实质，别删错）
4. 登记后状态为 `unverified`，此时**不影响现有站点访问**

### 步骤 2 · 去 DNS 服务商加记录（按域名类型二选一）

**A. 子域名**（如 `fleta.abrdns.com`、`www.example.com`）

| 主机记录 | 记录类型 | 记录值 |
|---|---|---|
| `fleta` | **CNAME** | `flyelep-wb-tracker.onrender.com` |

**B. 根域 / apex**（如 `example.com`）

| 主机记录 | 记录类型 | 记录值 |
|---|---|---|
| `@` | **A** | **`216.24.57.1`** |

> - 根域若 DNS 商支持 **ANAME / ALIAS**，也可指向 `flyelep-wb-tracker.onrender.com`
> - **Cloudflare**：根域**必须用 CNAME**（不能 A）
> - 🔴 **务必删掉已有的 AAAA 记录**（Render 只用 IPv4，留着会出怪问题）

### 步骤 3 · 等生效并点 Verify

- DNS 一般 5–30 分钟生效
- 回 Render → **Settings → Custom Domains** → 点该域名旁的 **Verify**
- 通过后 Render 自动签发 **Let's Encrypt** 免费证书，`https://你的域名` 即可访问

### 步骤 4 · 设为 Primary（可选）

DNS 生效后可在 **Custom Domains** 把新域名设为 Primary，其余绑定域名会自动 301 跳转到它。

`.cn` 域名注意：注册后**必须完成域名实名认证**，否则会被暂停解析。

## 🔧 换域名的代码改动清单

站点内共 **13 处**引用域名，换域名时全部替换（旧域名 → 新域名）：

| 文件 | 处数 | 内容 |
|---|---|---|
| `public/index.html` | 7 | `canonical`、`og:url`、schema `url` ×2、Organization `url`、`logo`、页脚「官网」链接 |
| `render.yaml` | 1 | `PUBLIC_URL` |
| `README.md` | 1 | 文档 |
| `DOMAIN_SETUP.md` | 4 | 本文件 |
| **Render 环境变量** | 1 | `PUBLIC_URL`（API `PUT /v1/services/<sid>/env-vars/PUBLIC_URL`） |

> `PUBLIC_URL` 只用于后台一个统计字段，**不影响图片上传** —— 上传链接是按请求头 `x-forwarded-proto` + host 动态拼的，会自动跟随真实域名。

## 📞 帮助

- Render 自定义域名文档：https://docs.render.com/custom-domains
- 通用 DNS 配置：https://docs.render.com/configure-other-dns
- 改完发布：`.\publish.ps1 -Message "绑定 xxx"`（或 `node scripts/ghpush.mjs "..."`）
