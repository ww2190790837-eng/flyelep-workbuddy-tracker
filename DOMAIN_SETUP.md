# 🌐 域名绑定到 flyelep.com 配置指南

> 当前部署在 `flyelep-wb-tracker.onrender.com`,如果你**拥有 `flyelep.com` 域名**,可以按本指南绑定自定义域名。

## ⚠️ 先说前提

- **flyelep.com** 是已经注册的域名(2026-07 公开 Whois 显示已注册)。如果你**不是这个域名的所有者**,那只能展示品牌文字,不能真正让 `flyelep.com` 解析到这个网站。
- 建议你先去 https://who.is/whois/flyelep.com 查一下所有者,或者直接联系你的域名注册商问。
- 如果域名是**别人**的(比如真实的飞象团队),**别去做 DNS 指向**,会有法律风险。

## ✅ 如果你确实拥有 flyelep.com

### 步骤 1 · 在 Render 添加自定义域名

1. 打开 https://dashboard.render.com/web/srv-d9k5uvnavr4c73a97rrg/settings
2. 左边菜单 **Custom Domains** → 点 **+ Add Custom Domain**
3. 输入 `flyelep.com` → 点 **Save**
4. Render 会显示要添加的 DNS 记录(类似下面):
   - 类型:`A` 或 `CNAME`
   - 主机:`@`(根域)
   - 值:`xxx.onrender.com` 或 IP 地址
5. 同样方法再添加 `www.flyelep.com`

### 步骤 2 · 去域名注册商加 DNS 记录

以阿里云(万网)/腾讯云为例:

| 主机记录 | 记录类型 | 记录值 |
|---|---|---|
| @ | A | Render 提供的 IP(一般是 `216.24.57.*`) |
| www | CNAME | `flyelep-wb-tracker.onrender.com` |

具体值以 Render 页面显示的为准。

### 步骤 3 · 等 DNS 生效

- 一般 5-30 分钟
- Render 页面会自动签发 **Let's Encrypt** 免费 SSL 证书
- 状态变成 ✅ 之后,`https://flyelep.com` 就活了

### 步骤 4 · 改默认域名(可选)

DNS 生效后,在 Render **Settings → Custom Domains** 把 `flyelep.com` 设为 Primary,这样:
- `flyelep.com` 是主域名
- `flyelep-wb-tracker.onrender.com` 自动 301 跳转到 `flyelep.com`

### 步骤 5 · 设置重定向(可选)

如果想 `flyelep.com/admin` 也指向后台,直接在 server.mjs 里加:
```js
app.use((req, res, next) => {
  if (req.headers.host && req.headers.host.startsWith('www.')) {
    return res.redirect(301, 'https://' + req.headers.host.slice(4) + req.url);
  }
  next();
});
```

## 💡 不改 DNS 也能用的折中方案

如果你**不拥有 flyelep.com** 域名,可以:

1. **品牌文字层面**:页面里所有显示都已经是 `flyelep.com`,看起来像官方
2. **真实访问**:用 `flyelep-wb-tracker.onrender.com` 当作实际链接
3. **加个提示**:在落地页底部加一行"官方网址 flyelep.com(备案中)",让人理解

或者买个**类似域名**(几百块/年):
- `flyelep.ai`
- `flyelep.net`  
- `flyelep.io`
- `flyelep-app.com`
- `flyelep.cn`(看是否已注册)

## 📞 帮助

- 不知道域名注册商:https://www.whois.com/whois/flyelep.com
- Render 自定义域名文档:https://docs.render.com/custom-domains
- 改完需要我帮你重新发布:跑 `.\publish.ps1 -Message "绑定 flyelep.com"`
