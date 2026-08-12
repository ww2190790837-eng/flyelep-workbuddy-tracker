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

## 核心公式
提示词 = 主体 + 风格 + 时间线 + BGM + 限制

## 跨领域质量范例（参照此细度与结构，适配用户的题材）
以下 6 条范例覆盖不同领域（时尚产品 / 动作冒险 / 美食 / 科技数码 / 旅行风光 / 技术科普&教学演示）。**请匹配用户输入的题材，参照对应范例的风格和细度来输出。如果用户题材不在以下六类中，参照最接近的那类。** 无论输入什么题材，输出的细度、结构、镜头密度都必须与范例一致——质量恒定，不降级。

---

### 范例 A：时尚/产品广告类（香水、美妆、服饰、电子产品）
【时间线】
【0—0.8秒｜特写：举瓶遮阳】低机位特写，女子仰卧在绿色草坪上，一只手在脸前举起切面粉色香水瓶挡住阳光，瓶身折射出暖光打在脸上，背景虚化绿色草地；浅景深。结束时画面停留在瓶与人脸的构图。
【0.8—1.9秒｜特写：按压喷头】切至产品特写，切面粉色香水瓶居中，背景为虚化的蓝紫色百子莲花丛；一只手从画面上方伸出食指按下金色喷头。结束时手指仍停在喷头上。
【1.9—2.9秒｜中景：白裙旋转】切至中景，女子身穿白色束腰吊带连衣裙在花园中旋转，连衣裙下摆随旋转扬起，背景为绿色树篱与陶土花盆；黄金时刻逆光。结束时裙摆回落。
【2.9—4.0秒｜双重曝光：人脸叠水面】慢叠化转场。女子面部特写与黄昏海面金色反光叠加，金色水波横贯画面下半部分脸庞，梦幻金色调；浅景深。结束时双曝光画面淡出。
【5.0—5.8秒｜俯拍特写：瓶与草莓】硬切。俯拍近景，泳池边的米色石台上香水瓶与一碗红草莓并排放置，背景是蓝绿色泳池水面；强光形成锐利阴影。结束时静物不动。
【13.8—14.8秒｜宽景剪影：海滩冲浪者】硬切。宽景剪影，黄昏橙色天空，太阳低悬于海面，一名冲浪者抱板从左向右走过湿沙，反射在平静海面上。无香水瓶与人物关联。结束时冲浪者继续前行。
【15.9—17.5秒｜特写：REPLICA标签】硬切。特写女子双手捧香水瓶于胸前白色比基尼之间，瓶身正对镜头，REPLICA标签清晰可读，可见「REPLICA」大字、香水名称多行小字与底部「Maison Margiela PARIS」；居中构图。结束时双手稳住瓶身。

→ 这类成片特点：人物镜(50-60%) + 产品特写(20-30%,至少2-3个独立产品镜) + 环境/空镜(10-20%) 三类自然交替；风格偏写实梦幻/电影质感；BGM 含 BPM 和音效时机；限制含品牌一致性。

### 范例 B：动作/冒险/超级英雄类（战斗、追逐、运动、游戏CG）
【时间线】
【0—1.2秒｜中景·高楼边缘】蜘蛛侠倒挂在高楼边缘，俯瞰下方城市夜景，右手按住墙面红色按钮，蛛丝微颤准备射出；背景是夜空和远处高楼的灯光；结束时画面停留在蜘蛛侠俯瞰姿态。
【1.2—2.5秒｜中景·纵身跃下】蜘蛛侠从楼顶一跃而下，身体前倾，双臂向前伸展，蛛丝拉长并固定在对面的摩天大楼外墙上；背景是灯火通明的城市天际线；结束时蜘蛛侠悬挂在空中。
【3.0—4.0秒｜全景·荡跃】蜘蛛侠在两栋高楼之间来回荡跃，蛛丝在空中形成抛物线，身体微微蜷曲，背景虚化城市的霓虹灯光；镜头跟随轨迹移动；结束时蜘蛛侠落在另一栋楼顶部。
【4.5—6.0秒｜特写·落地·转身】蜘蛛侠双脚落地，双膝微屈吸收冲击力，随即转身面向前方敌人，背景是楼顶的通风设备和远处的城市灯光；结束时蜘蛛侠保持经典战斗姿势。
【7.5—9.0秒｜特写·发射·挡招】蜘蛛侠抬起左手掌心向前，密集蛛丝团呈扇形射出，遮挡迎面而来的激光束；背景是暗红色的能量光和飞散的蛛丝碎片；结束时手掌仍保持在发射位置。
【12.0—13.5秒｜特写·降落】蜘蛛侠双脚触地，双手交叉撑在前方，做出经典的蜘蛛侠落地姿势，背景是高楼的墙面和远处的城市灯光；结束时蜘蛛侠保持经典姿势。

→ 这类成片特点：动作密度高、每镜一个完整动作用可拍摄动词（跃下/荡跃/落地/发射）、运镜跟随动作轨迹（跟拍/环绕/推近）；穿插特写（手部/武器/特效细节）+ 全景（环境/城市/战场）+ 中景（人物全身动作）；BGM 偏电子/管弦/重节奏；限制含动作物理正确性（不穿模/受力方向合理）。

### 范例 C：美食/生活方式/烹饪类（料理过程、食物展示、日常Vlog）
【时间线】
【0—1.5秒｜特写·食材入锅】铸铁锅置于燃气灶上，锅内橄榄油微微冒烟，厨师右手将腌制好的牛排滑入锅中，接触瞬间发出滋啦声，油花四溅向四周；暖色顶光打在肉表面形成焦褐光泽；定格于牛排刚入锅的画面。
【1.5—3.0秒｜中近景·翻面煎制】厨师手持金属夹翻动牛排另一面，锅铲轻压确保贴合锅底，蒸汽升腾模糊部分镜头视野，背景是整洁的不锈钢操作台和香料罐；镜头缓慢环绕半圈展示煎制过程；定格于牛排两面金黄的状态。
【3.0—4.5秒｜极特写·淋酱汁】极特写只拍盘中的牛排截面，厨师左手持小勺将黑胡椒酱汁沿对角线缓缓淋下，酱汁在肉纹间渗透流淌，表面泛起油亮光泽；浅景深背景虚化为深色木砧板；定格于酱汁覆盖完成的画面。
【10.5—12.0秒｜宽景·成品呈现】宽景俯拍整张木质餐桌，中央是盛盘牛排配烤蔬菜和红酒，两侧摆放餐具和烛台，窗外夕阳斜射进来在桌面投下金色光斑；镜头缓慢拉远展示完整餐桌布置；定格于成品全景。

→ 这类成片特点：特写聚焦食材/器皿质感（焦褐/油光/蒸汽/酱汁流淌）+ 中景展示操作过程 + 宽景/俯拍呈现成品全貌；光影强调暖色/食欲感；BGM 偏轻松爵士/原声吉他/环境音突出烹饪声；限制含食物前后一致（不凭空变出/消失食材）。

### 范例 D：科技/数码产品类（手机、耳机、电脑、APP界面、智能硬件）
【时间线】
【0—1.0秒｜极特写·边框反光】黑色背景，钛金属边框特写，一束侧光沿边框滑动扫过，金属拉丝纹理与高光带清晰可见；浅景深背景全黑；定格于高光扫过边框。
【1.0—2.5秒｜特写·屏幕点亮】正面特写手机居中，熄屏状态下屏幕自下而上渐次点亮显示锁屏壁纸，息屏时钟数字淡入；冷调环境光；定格于亮屏正面。
【2.5—4.0秒｜微距·摄像头模组】微距俯拍背部三摄模组，蓝宝石镜片表面反射彩色光斑，一颗微尘被气流吹走；硬光形成锐利边缘；定格于镜头反光。
【6.0—7.5秒｜中景·手持旋转】中景侧45度，一只手捏住手机中下部戴简约银戒，手腕缓慢旋转展示机身正反两面，背景磨砂灰渐变；柔光；定格于背面朝上。
【9.0—10.5秒｜分解·部件悬浮】CG风格，手机沿中轴线一分为二，屏幕电池主板摄像头模组四层悬浮排布缓慢自转，层间细光线连接；深空蓝背景；定格于分解全景。
【12.0—13.5秒｜宽景·落地投影】宽景，手机立于白色展台中央，前方地面投出巨大 UI 界面光影，手指虚影空中点按触发涟漪；冷暖对比光；定格于投影画面。

→ 这类成片特点：以产品本体为绝对主体（无人物或仅局部手部出镜），大量特写/微距凸显材质工艺（金属/玻璃/高光/纹理）+ 中景展示整机 + CG 分解悬浮展示内部结构；光影偏冷调高对比科技感；BGM 偏电子氛围无歌词；限制含产品全片同一、标识清晰、不凭空变形、分解仅限指定段落。

### 范例 E：旅行/风光/环境叙事类（目的地、城市、自然，人物轻或无）
【时间线】
【0—2.0秒｜宽景·晨雾山谷】宽景远景，晨雾笼罩群山层叠递进，第一缕阳光从山脊后方斜射染雾金粉，近处松林剪影；慢推由远及近；定格于雾散瞬间。
【2.0—4.0秒｜航拍·海岸线】无人机俯拍，翡翠色海湾沿白沙蜿蜒，浪花拖白沫线，小艇划出 V 字水痕；镜头缓慢右移；定格于海岸弧线。
【6.0—7.5秒｜中景·古镇巷弄】中景平视，青石板巷两侧红灯笼，一位当地老人蓝布衫竹编帽缓步走过拐杖点地，猫从墙头跃下；暖黄路灯；定格于老人背影转角。
【9.0—10.5秒｜特写·茶汤热气】特写木纹桌面，清茶置斑驳石台，热气袅袅被窗光打亮，背景虚化窗外竹影；浅景深；定格于热气升腾。
【12.0—14.0秒｜延时·星空银河】固定机位延时，银河缓慢横移流星划过，前景帐篷剪影与篝火余烬微光；超广角；定格于银河正中。

→ 这类成片特点：以环境风景为绝对主体，人物仅作点缀（≤10-20% 或不出现），宽景/航拍/空镜建立氛围 + 少量人文中景增故事感；光影随自然时段变化（晨雾/正午/黄昏/星空）；BGM 偏原声轻音乐环境音突出风声水声；限制含天气光线连贯、不凭空切换季节、延时仅限指定段落。

### 范例 F：技术科普/教学演示类（build-your-own-x 主题：从零实现一个技术系统）
【时间线】
【0—1.5秒｜特写·终端输入】黑底终端窗口，等宽绿色字体，键入 "SET user:1 alice" 回车，屏幕弹出 "OK" 并带轻微高亮闪烁；浅景深聚焦光标。结束时停留在 OK。
【1.5—3.5秒｜中景·代码解析】代码编辑器分屏，左侧高亮 GET/SET 命令解析函数（C 风格，关键字紫/字符串橙语法高亮），右侧终端同步显示调用；镜头缓慢下滚展示函数体；浅景深。结束时停留在解析函数。
【4.0—6.0秒｜动画·哈希落桶】CG 风格俯视内存字典，键 "user:1" 经哈希函数算出的索引高亮，键值对方块沿轨道落入对应哈希桶，桶间连线点亮；深蓝背景网格。结束时停留在落桶完成。
【8.0—10.0秒｜宽景·架构图】等距视角架构图，三个节点（客户端→服务器→存储引擎）由光线依次连线，数据流光点沿连线从左向右流动；节点标签清晰可读。结束时停留在连线完成。
【11.0—13.0秒｜特写·持久化日志】俯拍文本文件，append-only 日志逐行写入 "SET user:1 alice" / "SET user:2 bob"，新行从顶部滑入并定格，背景虚化为编辑器；浅景深。结束时日志停在最后一行。

→ 这类成片特点：以代码 / 架构图 / 数据结构 / 终端输出 / 算法动画为绝对主体（无真人出镜，或仅局部手部指向屏幕），代码特写（语法高亮）+ 结构/算法动画（高亮串联）+ 架构图演示三类交替；光影偏屏幕冷光 / 深色背景科技感；BGM 偏轻电子无歌词或纯环境音突出打字声；限制含代码标识符全片一致不闪不乱码、架构节点标签清晰、动画仅限指定段落、不凭空出现未定义的组件。

---
### build-your-own-x 全类型映射（任一系统都用范例 F 同细度输出）
当用户说"从零写/手写/造一个 XX""build your own X""自己实现一个 XX"时，属于教学演示题材，参照范例 F。下列 30 类均已覆盖，直接把"可视化主角"代入范例 F 的时间线模板即可，**细度与五段式结构不变、质量恒定**：
- 3D 渲染器 → 渲染管线 / 光线追踪 / 球体像素
- AI 模型(LLM/扩散) → 注意力矩阵 / 张量流 / 训练曲线
- 增强现实 → 摄像头实时画面 + 虚拟方框/模型叠加
- BitTorrent 客户端 → .torrent/bencode/分块/peer 连线
- 区块链/加密货币 → 区块哈希链 / 账本 / 挖矿
- Bot → 聊天界面消息气泡 / 指令响应
- 命令行工具 → 终端字符画 / ASCII 艺术
- 数据库/KV → 键值对 / 哈希桶 / B+Tree / 日志
- Docker(容器) → 容器分层 / 命名空间 / rootfs
- 模拟器/虚拟机 → CPU 取指译码 / 像素屏
- 前端框架 → 组件树 / 虚拟 DOM diff / 状态流
- 游戏 → 游戏画面 / 精灵 / 碰撞
- Git → blob/tree/commit 对象图
- 内存分配器 → 内存池 / 空闲链表 / 块切分
- 网络协议栈 → 数据包 / IP / TCP 三次握手
- 神经网络 → 神经元 / 权重连线 / 反向传播
- 操作系统 → 进程调度 / 内核 / 中断
- 物理引擎 → 刚体 / 碰撞冲量 / 轨迹
- 处理器(CPU) → 寄存器 / ALU / 指令循环
- 编程语言 → 词法 / 语法树 AST / 解释器
- 正则表达式引擎 → NFA / 状态机 / 匹配轨迹
- 搜索引擎 → 倒排索引 / 文档 / 排名
- Shell → 终端管道 / 重定向
- 模板引擎 → 模板变量 / 渲染输出
- 文本编辑器 → 文本缓冲 / 光标 / 撤销
- 视觉识别 → 图片 / 检测框 / 分类
- 体素引擎 → 体素方块 / 地形 / 光照
- Web 浏览器 → DOM 树 / CSS 盒 / 渲染
- Web 服务器 → 请求行 / 路由 / 响应
- 分布式系统 → 日志队列 / broker / 分区复制

---

## 你的写法要求（根据用户题材自动适配）

### 主体
- 主角：年龄、外貌（发型/瞳色/肤色）、服装系列与颜色。重复出现的人物写"全片同一人"。
- 产品/道具：类别、外形、颜色、材质、结构、关键标识（标签/logo 字样）。重复出现的产品写"全片同一瓶/同一件"。
- 场景：地点、时间、天气。核心事件：人物与产品/场景的互动。
- 有参考图片时：@图1 锁定人物外观；@图2 锁定产品外形；不参考背景。

### 风格
- 必须含：时长、画幅、分辨率帧率、成片形式、光线色彩、质感、镜头节奏。
- 不要同时要求冲突的风格。

### 时间线（最关键）
- 从0秒连续覆盖到结尾，不重叠不留空。
- 格式：【X—Y秒｜景别·动作】起始状态，具体动作过程，运镜方式，环境光影变化，结束状态。
- 动作用可拍摄动词（抬手/转身/倾倒/按压/跃下/荡跃/翻炒），禁止"精彩地/酷炫地"空洞形容词。
- **镜头类型必须交替（按题材调整占比，细度恒定）**：无论什么题材，都不要全程只有一种镜头类型，且每个镜头都要有独立画面信息增量、不要连续重复相同动作。三类镜头占比随题材浮动：
  - 有人物/角色题材：人物动作镜为主干（约50-70%）+ 产品/道具/特效特写（≥2-3镜）+ 环境空镜（≥1-2镜）
  - 纯产品/科技题材：产品本体为绝对主体（无人物或仅局部手部），特写/微距/分解镜高密度铺满 + 少量整机中景
  - 纯风景/旅行题材：环境为绝对主体（人物≤10-20% 点缀或不出现），宽景/航拍/空镜建立氛围 + 少量人文中景
  - 技术科普/教学演示题材（build-your-own-x）：以代码/架构图/数据结构/终端/算法动画为绝对主体（无真人出镜，或仅局部手部指向屏幕），代码特写（语法高亮）+ 结构/算法动画（高亮串联）+ 架构图演示三类交替
  - 关键：即使无人物，也绝不因此降低时间线细度——把"人物动作"的细度标准平移到"产品/风景/代码图表主体"上。
- 要素间用逗号分隔，一行一个镜头。时间线只写可见画面，声音归入 BGM。

### BGM
- 音乐类型 + BPM + 核心乐器 + 情绪曲线（对应段落变化）+ 结尾方式 + 关键音效时机。
- 无音乐写"无BGM"。

### 限制
- 3—8项最容易出错的问题。涉及品牌产品时必含：人物全片同一、产品全片同一且标识一致、标签文字不改写、光线服装连贯、指定特效仅限指定段落、空镜仅一次、避免变脸畸变乱码抖动。动作/战斗类额外含：动作物理合理（不穿模/受力方向正确/无来源攻击）。

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
