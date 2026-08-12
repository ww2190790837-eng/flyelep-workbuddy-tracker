import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || "flyelep-change-me-in-production-2026";
const PUBLIC_URL = process.env.PUBLIC_URL || "https://flyelep-wb-tracker.onrender.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "codex2026";
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== 简易 JSON DB =====
const USERS_FILE = path.join(DATA_DIR, "users.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const DB_FILE = path.join(DATA_DIR, "db.json");

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// 加载现有 visits/clicks DB(兼容)
let db = loadJSON(DB_FILE, { visits: [], clicks: [] });
function saveDB() { saveJSON(DB_FILE, db); }

// users(仅 JSON 回退使用 saveUsers;其余读写走下方 MongoDB 存储层)
function saveUsers(u) { saveJSON(USERS_FILE, u); }
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, plan: u.plan, role: u.role, avatar: u.avatar || null, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, loginCount: u.loginCount }; }

// ============================================================
//  用户存储层:优先 MongoDB(联网持久化),否则回退本地 JSON 文件
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI || "";
let usingMongo = false;
let UserModel = null;

// ---- GitHub Gist 持久化(备用联网存储:跨设备 + 重启不丢,无需 Atlas) ----
const GIST_TOKEN = process.env.USERS_GIST_TOKEN || "";
const GIST_ID = process.env.USERS_GIST_ID || "";
const GIST_FILENAME = "flyelep_users.json";
let usingGist = false;
let gistCache = [];
async function gistFetch() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "flyelep-tracker", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch " + r.status);
  const data = await r.json();
  const f = data.files && data.files[GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : [];
}
async function gistPush(users) {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "flyelep-tracker", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(users, null, 2) } } })
  });
  if (!r.ok) throw new Error("gist push " + r.status);
}

async function initUsersStore() {
  // 1) MongoDB 优先(联网持久化首选)
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
      const userSchema = new mongoose.Schema({
        id: { type: String, unique: true, index: true },
        email: { type: String, unique: true, lowercase: true, index: true },
        name: String,
        passwordHash: String,
        plan: { type: String, default: "trial" },
        role: { type: String, default: "user" },
        avatar: { type: String, default: null }, // 存 base64 data URL
        createdAt: Number,
        lastLoginAt: Number,
        loginCount: { type: Number, default: 1 }
      });
      UserModel = mongoose.model("User", userSchema);
      usingMongo = true;
      console.log("[store] 已连接 MongoDB,用户数据持久化到云端");
      return;
    } catch (e) {
      console.error("[store] MongoDB 连接失败,尝试 Gist 持久化:", e.message);
    }
  }
  // 2) GitHub Gist 持久化(跨设备 + 重启不丢,无需 Atlas)
  if (GIST_TOKEN && GIST_ID) {
    try {
      gistCache = await gistFetch();
      usingGist = true;
      console.log(`[store] 已启用 GitHub Gist 持久化(用户数 ${gistCache.length})`);
      return;
    } catch (e) {
      console.error("[store] Gist 读取失败,回退本地 JSON 文件:", e.message);
      gistCache = [];
    }
  }
  // 3) 本地 JSON(临时,重启可能丢)
  console.log("[store] 使用本地 JSON 文件(data/users.json)");
}

// 头像:校验 base64 data URL,直接存进用户文档(不再写文件)
function validateAvatar(dataUrl) {
  const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[3], "base64"); // m[3] 才是 base64 数据
  if (!buf || buf.length > 2 * 1024 * 1024) return null; // 解码后上限 2MB
  return dataUrl;
}

async function loadUsers() {
  if (usingMongo) return UserModel.find({}).lean();
  if (usingGist) return gistCache;
  return loadJSON(USERS_FILE, []);
}
async function findUserByEmail(email) {
  if (usingMongo) return UserModel.findOne({ email: String(email).toLowerCase() }).lean();
  return (await loadUsers()).find(u => u.email.toLowerCase() === String(email).toLowerCase());
}
async function findUserById(id) {
  if (usingMongo) return UserModel.findOne({ id }).lean();
  return (await loadUsers()).find(u => u.id === id);
}
async function createUser({ email, password, name }) {
  const id = nanoid(12);
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const user = {
    id, email: email.toLowerCase(), name: name || email.split("@")[0],
    passwordHash, plan: "trial", role: "user", avatar: null,
    createdAt: now, lastLoginAt: now, loginCount: 1
  };
  if (usingMongo) await UserModel.create(user);
  else if (usingGist) { gistCache.push(user); await gistPush(gistCache).catch(e => console.error("[store] gist push 失败:", e.message)); }
  else { const users = await loadUsers(); users.push(user); saveUsers(users); }
  return user;
}
async function updateUser(u) {
  if (usingMongo) await UserModel.updateOne({ id: u.id }, u, { upsert: false });
  else if (usingGist) {
    const idx = gistCache.findIndex(x => x.id === u.id);
    if (idx >= 0) { gistCache[idx] = u; await gistPush(gistCache).catch(e => console.error("[store] gist push 失败:", e.message)); }
  } else {
    const users = await loadUsers();
    const idx = users.findIndex(x => x.id === u.id);
    if (idx >= 0) { users[idx] = u; saveUsers(users); }
  }
}
async function deleteUserById(id) {
  if (usingMongo) { const r = await UserModel.deleteOne({ id }); return r.deletedCount > 0; }
  if (usingGist) {
    const before = gistCache.length;
    gistCache = gistCache.filter(u => u.id !== id);
    if (gistCache.length === before) return false;
    await gistPush(gistCache).catch(e => console.error("[store] gist push 失败:", e.message));
    return true;
  }
  const users = await loadUsers();
  const filtered = users.filter(u => u.id !== id);
  if (filtered.length === users.length) return false;
  saveUsers(filtered);
  return true;
}

function hash(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }
function getClientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || ""; }
function getUtm(q) {
  return {
    utm_source: q.utm_source || "", utm_medium: q.utm_medium || "", utm_campaign: q.utm_campaign || "",
    utm_content: q.utm_content || "", utm_term: q.utm_term || ""
  };
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser(SESSION_SECRET));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 3600 * 1000 // 30 天
  }
}));
// 管理员后台页(必须放在 static 之前,否则会被 extensions:['html'] 当文件直接返回,绕过鉴权)
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));

// ===== Auth 路由 =====
app.post("/api/auth/register", async (req, res) => {
  let { email, password, name } = req.body || {};
  email = String(email || "").trim().toLowerCase();
  if (!email || !password) return res.status(400).json({ ok: false, error: "请填写邮箱和密码" });
  if (!/^[^\s@]+@([^\s@.]+\.)+[^\s@.]+$/.test(email)) return res.status(400).json({ ok: false, error: "邮箱格式不正确" });
  if (password.length < 6) return res.status(400).json({ ok: false, error: "密码至少 6 位" });
  if (password.length > 64) return res.status(400).json({ ok: false, error: "密码太长" });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ ok: false, error: "该邮箱已注册,请直接登录" });
  const user = await createUser({ email, password, name });
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const rawEmail = String((req.body || {}).email || "").trim().toLowerCase();
  const password = (req.body || {}).password || "";
  if (!rawEmail || !password) return res.status(400).json({ ok: false, error: "请填写邮箱和密码" });
  const user = await findUserByEmail(rawEmail);
  if (!user) return res.status(401).json({ ok: false, error: "邮箱或密码错误" });
  if (!bcrypt.compareSync(password, user.passwordHash)) return res.status(401).json({ ok: false, error: "邮箱或密码错误" });
  user.lastLoginAt = Date.now();
  user.loginCount = (user.loginCount || 1) + 1;
  await updateUser(user);
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post("/api/auth/change-password", async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.status(401).json({ ok: false, error: "请先登录" });
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ ok: false, error: "请填写完整" });
  if (!bcrypt.compareSync(oldPassword, u.passwordHash)) return res.status(401).json({ ok: false, error: "当前密码不正确" });
  if (newPassword.length < 6 || newPassword.length > 64) return res.status(400).json({ ok: false, error: "新密码需 6-64 位" });
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
  await updateUser(u);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  res.json({ user: u ? publicUser(u) : null });
});

// 更新昵称 / 头像(需登录)
app.post("/api/auth/profile", async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.status(401).json({ ok: false, error: "请先登录" });
  const { name, avatar } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length === 0) return res.status(400).json({ ok: false, error: "昵称不能为空" });
    if (n.length > 40) return res.status(400).json({ ok: false, error: "昵称过长(最多 40 字)" });
    u.name = n;
  }
  if (avatar !== undefined) {
    if (avatar === null || avatar === "") {
      u.avatar = null;
    } else if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
      const valid = validateAvatar(avatar);
      if (!valid) return res.status(400).json({ ok: false, error: "头像格式不支持或文件过大(解码上限 2MB)" });
      u.avatar = valid;
    } else {
      return res.status(400).json({ ok: false, error: "头像数据无效" });
    }
  }
  await updateUser(u);
  res.json({ ok: true, user: publicUser(u) });
});

// ===== 跟踪 API(原有)=====
app.get("/t.gif", (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const ref = req.headers["referer"] || "";
  const u = getUtm(req.query);
  const vid = (req.cookies && req.cookies.vid) || hash(ip + ua);
  const isUnique = !(req.cookies && req.cookies.vid);
  const userId = req.session.userId || null;
  db.visits.push({ ts: Date.now(), ip, ua, referer: ref, path: req.query.p || "", ...u, vid, unique: isUnique ? 1 : 0, userId });
  if (db.visits.length > 20000) db.visits = db.visits.slice(-20000);
  saveDB();
  if (isUnique) { res.cookie("vid", vid, { maxAge: 30 * 24 * 3600 * 1000, sameSite: "lax" }); }
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
});

app.post("/api/click", (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const vid = (req.cookies && req.cookies.vid) || hash(ip + ua);
  const ref = req.headers["referer"] || "";
  const u = getUtm({ ...req.query, ...req.body });
  const { target, label } = req.body || {};
  const userId = req.session.userId || null;
  db.clicks.push({ ts: Date.now(), vid, ...u, target: target || "", label: label || "", userId });
  if (db.clicks.length > 20000) db.clicks = db.clicks.slice(-20000);
  saveDB();
  res.json({ ok: true });
});

// ===== Admin(原有)=====
function requireAdmin(req, res, next) {
  if (req.signedCookies && req.signedCookies.admin === "ok") return next();
  if (req.query.token === ADMIN_PASSWORD) {
    res.cookie("admin", "ok", { signed: true, maxAge: 7 * 24 * 3600 * 1000 });
    // 仅后台页面需要重定向到干净 URL;API 路由直接放行
    if (req.method === "GET" && req.path === "/admin") return res.redirect("/admin");
    return next();
  }
  // 未授权:转到干净的登录页;若带了 token 但错误,带 e=1 提示
  return res.redirect("/admin-login" + (req.query.token ? "?e=1" : ""));
}
app.get("/admin/api/stats", requireAdmin, async (req, res) => {
  const users = await loadUsers();
  res.json({
    total: db.visits.length,
    unique: db.visits.filter(x => x.unique).length,
    clicks: db.clicks.length,
    cvr: db.visits.length ? (db.clicks.length / db.visits.length * 100).toFixed(2) : "0",
    userCount: users.length,
    bySource: groupBy(db.visits, "utm_source", "(direct)"),
    byMedium: groupBy(db.visits, "utm_medium", "(none)"),
    byCampaign: groupBy(db.visits, "utm_campaign", "(none)"),
    byContent: groupBy(db.visits, "utm_content", "(none)"),
    clicksByTarget: groupBy(db.clicks, "target", "(unknown)"),
    recent: db.visits.slice(-50).reverse(),
    recentClicks: db.clicks.slice(-50).reverse(),
    byDay: groupByDay(db.visits),
    publicUrl: PUBLIC_URL,
    publicHost: req.get("host")
  });
});
function groupBy(arr, key, label) {
  const m = new Map();
  for (const x of arr) { const k = x[key] || label; m.set(k, (m.get(k) || 0) + 1); }
  return Array.from(m, ([k, v]) => ({ k, c: v })).sort((a, b) => b.c - a.c);
}
function groupByDay(arr) {
  const m = new Map();
  for (const x of arr) { const d = new Date(x.ts).toISOString().slice(0, 10); m.set(d, (m.get(d) || 0) + 1); }
  return Array.from(m, ([k, v]) => ({ d: k, c: v })).sort((a, b) => a.d.localeCompare(b.d));
}
app.get("/admin/api/reset", requireAdmin, (req, res) => {
  if (req.query.confirm !== "yes") return res.status(400).send("add ?confirm=yes");
  db = { visits: [], clicks: [] }; saveDB(); res.json({ ok: true });
});
app.get("/admin/api/export.csv", requireAdmin, (req, res) => {
  const v = db.visits;
  const header = ["id", "time", "ip", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "path", "referer", "is_unique", "user_id"];
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const lines = [header.join(",")];
  v.forEach((r, i) => { lines.push([i + 1, new Date(r.ts).toISOString(), r.ip, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.path, r.referer, r.unique, r.userId].map(esc).join(",")); });
  res.set("Content-Type", "text/csv;charset=utf-8");
  res.set("Content-Disposition", "attachment; filename=visits.csv");
  res.send("\uFEFF" + lines.join("\n"));
});

app.get("/admin/api/users", requireAdmin, async (req, res) => {
  const users = await loadUsers();
  res.json(users.map((u) => ({
    id: u.id, email: u.email, name: u.name, plan: u.plan, role: u.role,
    avatar: u.avatar || null,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, loginCount: u.loginCount
  })));
});

app.delete("/admin/api/users/:id", requireAdmin, async (req, res) => {
  const ok = await deleteUserById(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "用户不存在" });
  res.json({ ok: true });
});

// ===== AI 提示词生成(SD 2.5 / Seedance 五段式) =====
const AI_PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash"; // 留空则用工况默认模型
const AI_BASE_URL = process.env.AI_BASE_URL || ""; // OpenAI 兼容接口的 base URL(智谱/通义/DeepSeek 等)
const AI_VISION_MODEL = process.env.AI_VISION_MODEL || ""; // 处理图片时使用的视觉模型(默认回落到 AI_MODEL)

// OpenAI 兼容调用(支持多图 vision + 纯文本,支持自定义 base URL 如智谱/通义/DeepSeek)
// contentParts: [{type:"image_url",image_url:{url}}, {type:"text",text}]
async function callOpenAIChat(model, systemPrompt, contentParts, maxTokens) {
  const url = AI_BASE_URL ? `${AI_BASE_URL.replace(/\/$/, "")}/chat/completions` : "https://api.openai.com/v1/chat/completions";
  const body = { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: contentParts }], temperature: 0.7, max_tokens: maxTokens };
  // 免费模型共享算力,偶发 429 限流,自动重试
  const maxRetry = 3;
  let lastErr = "";
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` }, body: JSON.stringify(body) });
    if (r.ok) { const data = await r.json(); return data.choices?.[0]?.message?.content || ""; }
    const err = await r.json().catch(() => ({}));
    lastErr = err.error?.message || `AI API ${r.status}`;
    if (r.status === 429 && attempt < maxRetry - 1) { await new Promise(s => setTimeout(s, 4000 * (attempt + 1))); continue; }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

// Gemini API 调用(支持多图,parts 为 inlineData/text 数组)
async function callGemini(parts, systemText, maxTokens) {
  const model = AI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${AI_API_KEY}`;
  const contents = [{ role: "user", parts: [{ text: systemText }, ...parts] }];
  const body = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error?.message || `Gemini API ${r.status}`); }
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// DeepSeek API 调用(文本为主)
async function callDeepSeek(text, systemPrompt, maxTokens) {
  const model = AI_MODEL || "deepseek-chat";
  const url = "https://api.deepseek.com/chat/completions";
  const body = { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }], temperature: 0.7, max_tokens: maxTokens };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error?.message || `DeepSeek API ${r.status}`); }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}

// SD 2.5 五段式 System Prompt(来自 sd-2-5-prompt 技能，增强版)
const SD25_SYSTEM_PROMPT = `你是专业的视频提示词工程师，专精于 Seedance 2.5 / SD 2.5 视频生成。你的任务是把用户的创意（文字描述或+参考图片）整理成可直接复制使用的五段式视频提示词。

## 核心公式（必须严格遵守）
提示词 = 主体 + 风格 + 时间线 + BGM + 限制

## 五部分写法要求

### 主体
- 主角：年龄、外貌（发型/瞳色/肤色）、服装系列与颜色（如"全片白色系服装：白背心/白比基尼/白连衣裙"）、人数与关系。重复出现的人物必须写"全片同一人"，不换人、不复制、不出现额外人物。
- 产品/道具：写清类别、外形、颜色、材质、结构，以及关键标识（标签/logo 字样、顶盖/喷头等细节）。重复出现的产品写"全片同一瓶/同一件"，并规定比例与角度不漂移。
- 场景：地点、时间（黄金时刻/黄昏/正午）、天气、关键空间关系。
- 核心事件：人物与产品/场景完成什么互动。
- 如有参考图片：用 @图1 锁定人物外观；@图2 锁定产品外形；不参考背景。

### 风格
- 必须包含：时长、画幅、分辨率与帧率（如"20秒、16:9、1280×720、24帧"）、成片形式（真人电影级/动画/CG）、光线色彩、质感、镜头节奏
- 示例："20秒、16:9、1280×720、24帧的写实梦幻夏日时尚广告；黄金时刻暖金光、桃色与蓝绿点缀，偏暖柔和轻盈；浅景深与电影质感，多次双重曝光与俯拍旋转；硬切为主、个别转场用慢叠化"
- 不要同时要求互相冲突的风格（如"固定机位"与"持续高速环绕"）

### 时间线（最关键，必须足够详细、逐镜头）
- 从0秒连续覆盖到结尾，不重叠不留空，总时长严格等于目标时长。
- 每段格式：【X—Y秒｜景别·动作】起始状态，主体具体动作，运镜/拍法，环境光影变化，结束状态。
  - 景别用：特写/极特写/中近景/中景/宽景/俯拍/低机位 等；动作用可拍摄动词。
  - 例：【0—0.8秒｜特写·举瓶遮阳】女子仰卧草坪，单手举粉色切面瓶挡阳光，瓶身暖光折射打脸，背景虚化草地，浅景深，定格于瓶与脸构图。
- **每段只安排一个主要动作和一个主要运镜**，段与段用硬切或指定转场衔接，上一段结束态承接下一段起始态。
- **镜头密度必须足够细**：时尚/产品/情绪/广告类成片，单个镜头时长控制在 0.8—2.5 秒，镜头数下限——15秒不少于8个、20秒不少于10个、30秒不少于12个、60秒不少于20个（超长按比例增加）。禁止把整段压成 3—5 秒的粗糙大段。
- 动作用可拍摄的具体动词（抬手/转身/倾倒/搅拌/撕开包装），禁止用"精彩地/酷炫地/激烈地"等空洞形容词代替实际动作。
- **格式注意：要素间用逗号分隔，保持一行一个镜头，清晰可读。**

**时间线每段必须包含以下五要素，且每要素都要写满（缺一不可、不许省略）：**
1. **起始状态**：画面里有什么、人在哪里、物体什么位置、什么景别
2. **主体动作过程**：谁做了什么，从起势到变化的完整过程（不是"喷香水"一句结果，而是"右手握瓶、拇指下压喷头、极细气雾自喷口逸出"）
3. **运镜方式**：明确写推/拉/摇/移/跟/俯/仰/环绕/固定 + 速度（慢速/正常/急速），不能只写"特写"就算运镜
4. **环境/光影变化**：动作带来的视觉变化（气雾散射柔光、海面反光跳动、发丝边缘光、蒸汽模糊镜头）
5. **结束状态**：这段结束时画面定格在什么构图/姿态

**复杂动作额外要求（打斗/烹饪/抛接/液体/多人场景）：**
写清：谁发起 + 从哪里出发 + 沿什么路径/轨迹 + 作用于哪个对象 + 最后落在哪里 + 产生了什么视觉效果

**细节丰富度要求：**
- 写出具体的质感（陶瓷碗碰桌声、面条弹跳、油花四溅、蒸汽模糊镜头）
- 写出光影变化（灶火映红脸庞、窗外晨光斜射、霓虹灯在湿地面反射）
- 写出镜头距离变化（特写→中景→全景的切换逻辑）
- 时间线只写可见画面与镜头运动；声音/音效统一归入【BGM】段，不要在此写"海浪声/气雾声"等听觉内容。

### BGM
- 必须写：音乐类型 + 速度/BPM + 核心乐器 + 情绪曲线（开场→中段→收尾如何变化） + 结尾方式（干净长音/拖尾/定音）。
- 情绪曲线要对应到时间线段落（如"中段白裙旋转与海滩段旋律上行成小高潮"）。
- 关键音效列出具体声音与出现时机（如"按压极轻气雾声、旋转布料沙沙、泳池水声"），与音乐同处一个环境声场。
- 如有对白：写明说话人、语言、原文内容、情绪、口型同步要求。
- 无音乐时明确写"无BGM"。

### 限制
- 只写 3—8 项最容易出错的问题，优先真实风险。
- 涉及真实品牌/产品时必须包含：①人物全片同一人、不换人/复制/额外人物；②产品全片同一件、外形/标识/比例角度一致；③瓶身/包装标签文字以原片可读内容为准，不擅自增删改写品牌名与字段（外加字幕除外）；④光线与服装前后连贯，不跳光/夜景/非指定服装；⑤转场/特效仅出现在指定段落，其余不叠加不加水印；⑥特定空镜/剪影仅出现一次不复用；⑦避免变脸、畸变、廉价塑料感、过曝丢细节、乱码、黑边、抖动。
- 先修正文中矛盾，再用否定词精确约束。

## 输出质量标准
- 前1-2秒必须出现主体、产品或强视觉动作（不要空白开场）
- 人物、产品、场景前后一致（固定身份"全片同一"贯穿全片）
- 每段动作能在分配时间内完成（不要一段塞10秒的动作进3秒窗口）
- 结尾有明确动作落点或稳定英雄画面（不要突然黑屏或中断）
- 时间线总时长严格等于目标时长

## 输出格式
严格按以下五个标题输出，不要额外分析：
【主体】
...

【风格】
...

【时间线】
...

【BGM】
...

【限制】
...`;

// 视频反推: 视觉模型逐帧描述的系统提示(每帧单独调用,独享输出额度)
const VIDEO_VISION_SYS = `你是一名资深视频画面分析师。你会收到一张视频关键帧截图。请对这张画面做极其详尽的分析。

必须按以下格式输出（每个字段都要写满，不要省略）：

## 第N帧画面分析
**画面内容**：用2-3句话详细描述画面里有什么（人物/物体/场景/背景/前景），具体到颜色、位置、相对关系。
**主体细节**：人物的性别、年龄范围、发型、衣着（上衣/下装/鞋/配饰的具体款式和颜色）、表情、姿态；或产品的外形、材质、颜色、尺寸、品牌标识。
**环境与布景**：室内/室外、房间类型、家具摆设、墙面地面材质、窗外景色、灯光设备。
**光影与色彩**：主光源方向（左/右/顶/侧逆）、光线强度（强/中/弱/柔）、色温（暖/冷/中性）、整体色调（主色+辅助色）、阴影方向与硬度、是否有反光/高光/光晕。
**镜头信息**：画幅比例（16:9/9:16/1:1等）、镜头距离（特写/近景/中景/全景/远景）、拍摄角度（平视/俯仰/侧角）、景深（浅/深）。
**动态线索**：从画面能推断出的动作方向（谁在动、往哪动、什么状态变化）、运动模糊方向、飘散物（烟/蒸汽/水花/灰尘）、衣物/头发的飘动方向。
**文字与UI**：画面中的任何文字内容（字幕/水印/Logo/标签）、UI元素。

注意：只描述画面真实可见的内容。如果某帧看不清某些细节就写"该帧此区域不清晰"，不要编造。`;

// 视频反推: 文本模型根据逐帧详细描述反推五段式提示词
const REVERSE_SYSTEM_PROMPT = `你是顶级视频提示词工程师（Seedance 2.5 / SD 2.5 专家级）。现在有一段已生成的视频，下面是它的**逐帧像素级画面分析**（每帧都经过视觉AI独立详尽分析）。你的任务是【原片反推】——还原出一份可直接用于重新生成该视频的专业五段式提示词。

## 反推质量标准（必须达到）
- 时间线是核心价值：每段必须像电影分镜脚本一样详细，不是一句话概括
- 每段包含：起始状态（画面有什么、人在哪、物体什么位置）→ 具体动作过程（谁做了什么、怎么做的、中间状态变化）→ 运镜方式（推/拉/摇/移/跟/环绕+速度+角度）→ 环境光影变化（动作带来的视觉反馈：蒸汽/飞溅/反光/烟雾/阴影移动）→ 结束状态（定格在什么画面）
- 用逗号分隔要素，一行一个时间段，不要箭头串行
- 主体写清外观特征（让AI生成时能还原同一人/同一产品）
- 风格写清画幅/成片类型/光线方案/色彩体系/质感/镜头节奏
- BGM 即使原片无音乐也要推测适合的音乐风格和节奏；如有对白要写出原文
- 限制只写最关键的 3-6 项（变脸/换装/变形/穿模/乱码/水印）

## 核心公式
提示词 = 主体 + 风格 + 时间线 + BGM + 限制

## 输出格式
严格按以下五个标题输出，不要额外分析：
【主体】
...

【风格】
...

【时间线】
...

【BGM】
...

【限制】
...`;

// 统一调度
async function generatePrompt(idea, duration, images, mode) {
  const dur = Number(duration) || 15;
  const isReverse = mode === "reverse";
  const sys = isReverse ? REVERSE_SYSTEM_PROMPT : SD25_SYSTEM_PROMPT;
  const imgList = Array.isArray(images) ? images.filter(Boolean).slice(0, 24) : (images ? [images] : []);

  const userMsg = `请根据以下创意生成${dur}秒的SD 2.5视频提示词（五段式）：

${idea}

${imgList.length ? "\n[注：用户已上传参考图片/视频帧，请结合画面内容进行分析和提示词编写]" : ""}

【重要】时间线是核心，每段必须写满：起始状态、具体动作过程、运镜方式、环境光影变化、结束状态。动作要具体可拍摄（如"右手抓起竹筷挑起面条"而非"做面条"），写出质感细节（蒸汽/反光/飞溅/烟雾）。**格式要求：每段用逗号分隔要素，一行一个时间段，不要用分号或连续箭头。**请直接输出完整的五段式提示词，不需要额外解释。`;

  switch (AI_PROVIDER) {
    case "openai": {
      const textModel = AI_MODEL || "gpt-4o-mini";
      const visionModel = AI_VISION_MODEL || textModel;
      // 视频反推: 逐帧分析(每帧独占视觉模型输出额度) → 合并描述 → 文本模型反推五段式
      if (isReverse && imgList.length) {
        const isFlash = /v-flash/.test(visionModel);
        const visMax = isFlash ? 1024 : (imgList.length > 12 ? 1536 : 2048); // 帧多时收紧单帧额度,避免聚合描述超出文本模型上下文
        // 逐帧单独调用视觉模型,每帧获得完整详细描述
        const frameDescs = [];
        for (let fi = 0; fi < imgList.length; fi++) {
          const frameParts = [
            { type: "image_url", image_url: { url: imgList[fi], detail: "auto" } },
            { type: "text", text: `这是第${fi + 1}帧（共${imgList.length}帧，位于视频约${((fi + 0.5) / imgList.length * 100).toFixed(0)}%处）。请按系统提示格式对这一帧做极其详尽的分析。` }
          ];
          try {
            const fd = await callOpenAIChat(visionModel, VIDEO_VISION_SYS, frameParts, visMax);
            frameDescs.push(`--- 第${fi + 1}帧 ---\n${fd}`);
          } catch (e) {
            // 单帧失败不阻断,记录错误继续
            frameDescs.push(`--- 第${fi + 1}帧 ---\n[该帧分析失败: ${e.message}]`);
          }
        }
        const desc = frameDescs.join("\n\n");
        const finalText = `以下是该视频的逐帧像素级画面分析（共${imgList.length}帧，每帧独立详尽分析），请据此原片反推五段式提示词。视频总时长约${dur}秒：\n\n${desc}\n\n${idea ? ("用户补充要求：" + idea) : ""}`;
        return await callOpenAIChat(textModel, REVERSE_SYSTEM_PROMPT, [{ type: "text", text: finalText }], 4096);
      }
      // 普通生成(单图或纯文本)
      const content = [];
      if (imgList.length) imgList.forEach(src => content.push({ type: "image_url", image_url: { url: src, detail: "auto" } }));
      content.push({ type: "text", text: userMsg });
      const isFlash = /v-flash/.test(imgList.length ? visionModel : textModel);
      return await callOpenAIChat(imgList.length ? visionModel : textModel, sys, content, isFlash ? 1024 : 4096);
    }
    case "deepseek": {
      const note = imgList.length ? "\n[注：用户上传了视频帧图片，请结合画面内容分析]\n" : "";
      return await callDeepSeek(note + userMsg, sys, 4096);
    }
    case "gemini":
    default: {
      const parts = [];
      if (imgList.length) imgList.forEach(src => parts.push({ inlineData: { mimeType: src.match(/^data:(.*?);/)?.[1] || "image/png", data: src.replace(/^data:(.*?);base64,/, "") } }));
      parts.push({ text: userMsg });
      return await callGemini(parts, sys, 4096);
    }
  }
}

// 前端上传(图片/视频帧)大小限制 25MB(JSON base64)
app.post("/api/prompt-generate", express.json({ limit: "25mb" }), async (req, res) => {
  try {
    // 检查 AI 是否配置
    if (!AI_API_KEY) return res.status(503).json({ ok: false, error: "AI 服务未配置，请联系管理员设置 API Key", needConfig: true });

    let idea = "", duration = 15, images = [], mode = "create";

    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      return res.status(400).json({ ok: false, error: "请使用 JSON 格式上传（前端已改为 base64 JSON）" });
    }
    // JSON 格式(支持 images 数组:多张视频帧/参考图,以及 mode: create|reverse)
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    idea = body.idea || "";
    duration = Number(body.duration) || 15;
    mode = body.mode || "create";
    if (Array.isArray(body.images)) images = body.images.filter(Boolean).slice(0, 24);
    else if (body.image) images = [body.image]; // 兼容旧单图字段

    if (!idea && images.length === 0) return res.status(400).json({ ok: false, error: "请输入创意描述或上传参考图片/视频" });
    if (idea.length > 5000) return res.status(400).json({ ok: false, error: "描述过长（限5000字）" });

    const prompt = await generatePrompt(idea, duration, images, mode);
    if (!prompt || prompt.trim().length < 20) return res.status(502).json({ ok: false, error: "AI 返回结果异常，请重试" });

    res.json({ ok: true, prompt: prompt.trim(), provider: AI_PROVIDER });
  } catch (e) {
    console.error("[ai] generate error:", e.message);
    res.status(500).json({ ok: false, error: "AI 生成失败: " + e.message });
  }
});

// AI 配置状态查询(前端用来判断是否可用)
app.get("/api/prompt-generate/status", (req, res) => {
  const model = AI_MODEL || (AI_PROVIDER === "gemini" ? "gemini-2.5-flash" : AI_PROVIDER === "openai" ? "gpt-4o-mini" : "deepseek-chat");
  const visionModel = AI_VISION_MODEL || model;
  res.json({
    available: !!AI_API_KEY,
    provider: AI_PROVIDER,
    model,
    visionModel,
    supportsImage: AI_PROVIDER !== "deepseek", // deepseek 暂不支持图片输入
    supportsVideo: AI_PROVIDER !== "deepseek" // 视频抽帧后按多图处理,deepseek 暂不支持图片
  });
});

app.get("/healthz", (req, res) => res.json({
  ok: true,
  ts: Date.now(),
  store: usingMongo ? "mongodb" : (usingGist ? "gist" : "json"),
  mongoConfigured: !!MONGODB_URI,
  mongoConnected: mongoose.connection.readyState === 1,
  aiAvailable: !!AI_API_KEY,
  aiProvider: AI_PROVIDER
}));

await initUsersStore();
app.listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));
