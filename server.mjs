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

async function initUsersStore() {
  if (!MONGODB_URI) {
    console.log("[store] 未配置 MONGODB_URI,使用本地 JSON 文件(data/users.json)");
    return;
  }
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
  } catch (e) {
    console.error("[store] MongoDB 连接失败,回退本地 JSON 文件:", e.message);
    usingMongo = false;
  }
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
  else { const users = await loadUsers(); users.push(user); saveUsers(users); }
  return user;
}
async function updateUser(u) {
  if (usingMongo) await UserModel.updateOne({ id: u.id }, u, { upsert: false });
  else {
    const users = await loadUsers();
    const idx = users.findIndex(x => x.id === u.id);
    if (idx >= 0) { users[idx] = u; saveUsers(users); }
  }
}
async function deleteUserById(id) {
  if (usingMongo) { const r = await UserModel.deleteOne({ id }); return r.deletedCount > 0; }
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
app.use(express.json({ limit: "256kb" }));
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

app.get("/healthz", (req, res) => res.json({
  ok: true,
  ts: Date.now(),
  store: usingMongo ? "mongodb" : "json",
  mongoConfigured: !!MONGODB_URI,
  mongoConnected: mongoose.connection.readyState === 1
}));

await initUsersStore();
app.listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));
