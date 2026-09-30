import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import crypto from "node:crypto";
import IP2RegionPkg from "ip2region";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import multer from "multer";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobePathRaw from "ffprobe-static";
// ffmpeg-static 导出字符串; ffprobe-static@2 导出 { path } 对象, 统一成字符串
import {
  PORT, SESSION_SECRET, PUBLIC_URL, ADMIN_PASSWORD, DATA_DIR,
  USERS_FILE, EVENTS_FILE, DB_FILE, CODES_FILE, IP_CLAIM_FILE, PROMPTS_FILE,
  MONGODB_URI,
  GIST_TOKEN, GIST_ID, GIST_FILENAME, CODES_GIST_FILENAME, TRACKING_GIST_FILENAME,
  IP_CLAIM_GIST_FILENAME, PROMPTS_GIST_FILENAME, MESSAGES_GIST_FILENAME,
  VIDEO_USE_API_KEY, VIDEO_USE_API_BASE, VIDEO_USE_AUTH_HEADER,
  MAX_TRACK, MAX_PROMPTS, MAX_MESSAGES,
  REG_WINDOW_MS, REG_MAX_PER_IP,
  OTP_TTL_MS, OTP_RESEND_MS, OTP_MAX_ATTEMPTS, OTP_SEND_MAX_PER_IP_HOUR,
  AI_API_KEY, AI_PROVIDER, AI_MODEL, AI_BASE_URL, AI_VISION_MODEL
} from "./lib/config.js";
import { EMAIL_ENABLED, sendVerificationEmail } from "./lib/mail.js";
import { callOpenAIChat, callGemini, callDeepSeek, visionCandidates } from "./lib/ai.js";
import {
  store, loadJSON, saveJSON, saveDB, saveCodes, saveUsers, publicUser, gistWrite,
  collectPrompt, selectFewShots, buildFewShotBlock, extractIntent,
  regWindowCount, regHit, otpSendCount, genCode, initUsersStore, validateAvatar,
  loadUsers, findUserByEmail, findUserById, requireAuth, createUser, updateUser, deleteUserById,
  hash, getClientIp, resolveRegion, getUtm
} from "./lib/store.js";
import { requireAdmin } from "./lib/middleware.js";
import { mountAuth } from "./lib/auth.js";
import { mountAgnes } from "./lib/agnes.js";
import { mountAdmin } from "./lib/admin.js";

const ffmpegPath = typeof ffmpegPathRaw === "string" ? ffmpegPathRaw : ffmpegPathRaw.path;
const ffprobePath = typeof ffprobePathRaw === "string" ? ffprobePathRaw : ffprobePathRaw.path;

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
// 统一包装 async 路由:Express 4 不会捕获 async handler 的 rejected Promise,
// 这里把异常转交给下方错误中间件,避免请求挂起或进程因 unhandledRejection 崩溃
app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser(SESSION_SECRET));
// 登录态改为「无状态签名 Cookie」:userId 直接写在签名 Cookie 里,服务端不再保存任何会话。
// 这样部署/重启(服务端内存被清空)也不会掉登录;只要 SESSION_SECRET 稳定,老 Cookie 永远有效。
const SESSION_MAX_AGE = 365 * 24 * 3600 * 1000; // 1 年(之前是 30 天,部署就被踢)
function _sessionCookieOpts() {
  return { signed: true, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: SESSION_MAX_AGE };
}
app.use((req, res, next) => {
  let _uid = (req.signedCookies && req.signedCookies.uid) || null;
  req.session = {
    get userId() { return _uid; },
    set userId(v) {
      _uid = v == null ? null : String(v);
      if (_uid != null) res.cookie("uid", _uid, _sessionCookieOpts());
      else res.clearCookie("uid", { signed: true, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    },
    destroy(cb) {
      _uid = null;
      res.clearCookie("uid", { signed: true, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
      if (typeof cb === "function") cb();
    }
  };
  next();
});
// 管理员后台页(必须放在 static 之前,否则会被 extensions:['html'] 当文件直接返回,绕过鉴权)
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
// 账户设置页(独立页,大厂风格:头像/昵称单独设置;放在 static 之前以便 /settings 精确命中)
app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});
// 旧账户页入口兼容:登录后不再跳转到 /account,统一回首页,旧书签重定向到首页
app.get(["/account", "/account.html"], (req, res) => {
  res.redirect("/");
});
mountAuth(app);
mountAgnes(app);
mountAdmin(app);
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));

// ===== 跟踪 API(原有)=====
app.get("/t.gif", (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const ref = req.headers["referer"] || "";
  const u = getUtm(req.query);
  const vid = (req.cookies && req.cookies.vid) || hash(ip + ua);
  const isUnique = !(req.cookies && req.cookies.vid);
  const userId = req.session.userId || null;
  store.db.visits.push({ ts: Date.now(), ip, region: resolveRegion(ip), ua: (ua || "").slice(0, 300), referer: (ref || "").slice(0, 300), path: req.query.p || "", ...u, vid, unique: isUnique ? 1 : 0, userId });
  if (store.db.visits.length > MAX_TRACK) store.db.visits = store.db.visits.slice(-MAX_TRACK);
  saveDB();
  if (isUnique) { res.cookie("vid", vid, { maxAge: 30 * 24 * 3600 * 1000, sameSite: "lax" }); }
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
});

// ===== 留言板 API(公开,无需登录) =====
app.get("/api/messages", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(30, Math.max(5, parseInt(req.query.pageSize) || 20));
  const start = (page - 1) * pageSize;
  const sorted = [...store.messages].sort((a, b) => b.ts - a.ts);
  const items = sorted.slice(start, start + pageSize);
  res.json({ total: store.messages.length, page, pageSize, items });
});
app.post("/api/messages", requireAuth, async (req, res) => {
  const content = (req.body.content || "").trim().slice(0, 300);
  const name = (req.body.name || "").trim().slice(0, 30);
  if (!content) return res.status(400).json({ ok: false, error: "留言内容不能为空" });
  if (content.length < 2) return res.status(400).json({ ok: false, error: "留言内容至少 2 个字" });
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || "匿名用户",
    content,
    ts: Date.now(),
    ip: getClientIp(req),
  };
  store.messages.push(msg);
  // 超上限裁剪
  if (store.messages.length > MAX_MESSAGES) store.messages = store.messages.slice(-MAX_MESSAGES);
  // 异步落 Gist(不阻塞响应)
  gistWrite(MESSAGES_GIST_FILENAME, store.messages.slice(0, MAX_MESSAGES)).catch(e => console.error("[messages] Gist 落盘失败:", e.message));
  res.json({ ok: true, msg: { id: msg.id, name: msg.name, content: msg.content, ts: msg.ts } });
});

app.post("/api/click", (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const vid = (req.cookies && req.cookies.vid) || hash(ip + ua);
  const ref = req.headers["referer"] || "";
  const u = getUtm({ ...req.query, ...req.body });
  const { target, label } = req.body || {};
  const userId = req.session.userId || null;
  store.db.clicks.push({ ts: Date.now(), ip, region: resolveRegion(ip), ua: (ua || "").slice(0, 300), referer: (ref || "").slice(0, 300), vid, ...u, target: target || "", label: label || "", userId });
  if (store.db.clicks.length > MAX_TRACK) store.db.clicks = store.db.clicks.slice(-MAX_TRACK);
  saveDB();
  res.json({ ok: true });
});

// ===== AI 对话框(AI写代码助手,接入 Build Your Own X 知识) =====
const CHAT_SYSTEM_PROMPT = `你是 Fleta AI 写代码助手，专精于"从零实现技术系统"(Build Your Own X)领域。你的知识库覆盖 30+ 经典技术系统的从零实现方法，并擅长写出可直接运行的代码。

## 你的核心能力
当用户想自己写/手写/从零实现/造一个以下任何系统时，你能给出完整的实现指导和可直接运行的代码：
3D渲染器、AI模型、增强现实、BitTorrent、区块链、Bot、命令行工具、数据库、Docker、模拟器/虚拟机、前端框架/库、游戏、Git、内存分配器、网络协议栈、神经网络、操作系统、物理引擎、处理器(CPU)、编程语言、正则表达式引擎、搜索引擎、Shell、模板引擎、文本编辑器、视觉识别系统、体素引擎、Web浏览器、Web服务器、分布式系统 等。

## 回答风格
- 用中文回答（专有名词保留英文）
- 先确认目标系统和语言，再拆分 5-10 个递增里程碑
- 每个里程碑都要能独立运行验证
- 给出最小可运行代码（MVP 阶段单文件优先）
- 强调"做中学"，解释关键原理
- 如果用户问其他领域问题，友好引导回 BYOX 方向，但也可以正常聊天
- 保持简洁实用，不要废话`;

app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "消息不能为空" });
    }
    if (!AI_API_KEY) {
      return res.json({ reply: "🤖 AI 服务暂未配置，请稍后再试。\n\n你可以先试试站内的「提示词生成」和「视频反推」功能 ✨", usage: { provider: "none" } });
    }

    // 构建对话历史
    const chatMessages = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];
    history.forEach(h => {
      if (h.role === "user") chatMessages.push({ role: "user", content: h.content });
      else if (h.role === "assistant") chatMessages.push({ role: "assistant", content: h.content });
    });
    chatMessages.push({ role: "user", content: message.trim() });

    let reply = "";
    if (AI_PROVIDER === "gemini") {
      // Gemini: 把 system + history 合并为 context
      const parts = [];
      chatMessages.slice(1).forEach(m => {
        parts.push({ text: (m.role === "user" ? "用户: " : "助手: ") + m.content });
      });
      reply = await callGemini(parts, CHAT_SYSTEM_PROMPT, 2048);
    } else if (AI_PROVIDER === "deepseek") {
      // DeepSeek/OpenAI兼容: 直接传 messages 数组
      const model = AI_MODEL || "deepseek-chat";
      const url = AI_PROVIDER === "deepseek" && !AI_BASE_URL
        ? "https://api.deepseek.com/chat/completions"
        : `${(AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
        body: JSON.stringify({ model: AI_MODEL || model, messages: chatMessages, temperature: 0.7, max_tokens: 2048 })
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error?.message || `Chat API ${r.status}`); }
      const data = await r.json();
      reply = data.choices?.[0]?.message?.content || "";
    } else if (AI_PROVIDER === "qwen") {
      // 通义千问 OpenAI 兼容接口
      reply = await callOpenAIChat(AI_MODEL || "qwen-flash", CHAT_SYSTEM_PROMPT, message, 2048);
    } else {
      // OpenAI 兼容
      reply = await callOpenAIChat(AI_MODEL || "gpt-4o-mini", CHAT_SYSTEM_PROMPT, message, 2048);
    }

    res.json({ reply: reply || "抱歉，我没有生成回复。请换个方式提问。", usage: { provider: AI_PROVIDER, model: AI_MODEL } });
  } catch (e) {
    console.error("[chat]", e.message);
    res.status(500).json({ error: "AI 对话失败: " + e.message });
  }
});

// ===== Video-Use 辅助 API (Scribe 类: 查剩余免费分钟 / 提交视频转写处理) =====
// 状态(不向前端泄露完整 key)
app.get("/api/video-use/status", requireAuth, (req, res) => {
  res.json({
    ok: true,
    configured: !!VIDEO_USE_API_KEY,
    keyPreview: VIDEO_USE_API_KEY ? VIDEO_USE_API_KEY.slice(0, 8) + "..." + VIDEO_USE_API_KEY.slice(-4) : "",
    base: VIDEO_USE_API_BASE
  });
});

// 查剩余额度(单位无关: 自动识别 分钟/字符/积分/次数 等任意额度字段)
app.get("/api/video-use/quota", requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${VIDEO_USE_API_BASE}/v1/user/subscription`, {
      headers: { [VIDEO_USE_AUTH_HEADER]: VIDEO_USE_API_KEY }
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.json({ ok: false, error: `API ${r.status}`, detail: txt.slice(0, 300) });
    }
    const d = await r.json().catch(() => ({}));
    // 按常见额度字段依次匹配, 带上单位
    let quota = null, unit = null;
    if (typeof d.free_minutes === "number") { quota = d.free_minutes; unit = "分钟"; }
    else if (typeof d.remaining_minutes === "number") { quota = d.remaining_minutes; unit = "分钟"; }
    else if (typeof d.minutes_left === "number") { quota = d.minutes_left; unit = "分钟"; }
    else if (d.quota && typeof d.quota.minutes === "number") { quota = d.quota.minutes; unit = "分钟"; }
    else if (typeof d.character_limit === "number" && typeof d.character_count === "number") {
      quota = Math.max(0, d.character_limit - d.character_count); unit = "字符";
    }
    else if (typeof d.credit_balance === "number") { quota = d.credit_balance; unit = "积分"; }
    else if (typeof d.remaining_credits === "number") { quota = d.remaining_credits; unit = "积分"; }
    else if (typeof d.credits === "number") { quota = d.credits; unit = "积分"; }
    else if (typeof d.remaining_requests === "number") { quota = d.remaining_requests; unit = "次"; }
    else if (typeof d.remaining === "number") { quota = d.remaining; unit = ""; }
    res.json({ ok: true, quota, unit, tier: d.tier || d.plan || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============================================================
//  Video-Use 完整剪辑流水线: 上传 → Scribe 转写 → AI 剪辑策略 → ffmpeg 出片
// ============================================================
const VU_JOBS = path.join(DATA_DIR, "vu_jobs");
if (!fs.existsSync(VU_JOBS)) fs.mkdirSync(VU_JOBS, { recursive: true });
const vuUpload = multer({
  dest: path.join(os.tmpdir(), "vu_uploads"),
  limits: { fileSize: 400 * 1024 * 1024, files: 20 }
});

function fmt2(t) { const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`; }
function fmtSrt(t) { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`; }
function extractJSON(text) { try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }

// 统一 AI 文本调用(复用现有 provider)
async function aiText(system, user) {
  if (!AI_API_KEY) throw new Error("AI 服务未配置");
  if (AI_PROVIDER === "gemini") return await callGemini([{ text: user }], system, 4000);
  if (AI_PROVIDER === "deepseek") return await callDeepSeek(user, system, 4000);
  if (AI_PROVIDER === "qwen") return await callOpenAIChat(AI_MODEL || "qwen-flash", system, user, 4000);
  return await callOpenAIChat(AI_MODEL || "gpt-4o-mini", system, user, 4000);
}
// ffprobe 取元数据
async function probeMedia(file) {
  const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=index,width,height,codec_type,codec_name", "-of", "json", file]);
  return JSON.parse(stdout);
}
function pickPrimary(metas) {
  let best = null;
  for (const m of metas) {
    const hasVideo = (m.streams || []).some(s => s.codec_type === "video");
    const dur = parseFloat(m.format?.duration || "0");
    if (hasVideo && (!best || dur > best.dur)) best = { ...m, dur };
  }
  return best || metas[0];
}
// Scribe 文件转写
// 注意: ElevenLabs Scribe 免费层对单文件大小和时长有限制, 建议不超过 100MB / 30分钟
const SCRIBE_MAX_BYTES = 100 * 1024 * 1024; // 100MB 安全上限
async function scribeTranscribe(filePath, name) {
  const stat = fs.statSync(filePath);
  if (stat.size > SCRIBE_MAX_BYTES) {
    throw new Error(`文件过大(${(stat.size/1024/1024).toFixed(1)}MB), 超过 Scribe 安全上限(${SCRIBE_MAX_BYTES/1024/1024}MB)。建议先用 ffmpeg 压缩或裁剪后再试。`);
  }
  // 流式读取避免 OOM: 用 createReadStream + 可读流包装, 不一次性 readFileSync 全量进内存
  const fd = new FormData();
  const fileStream = fs.createReadStream(filePath);
  fd.append("file", new Blob([await streamToBuffer(fileStream)], { type: guessMime(name) }), name);
  fd.append("model_id", "scribe_v1");
  const r = await fetch(`${VIDEO_USE_API_BASE}/v1/speech-to-text`, { method: "POST", headers: { [VIDEO_USE_AUTH_HEADER]: VIDEO_USE_API_KEY }, body: fd, signal: AbortSignal.timeout(300_000) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`Scribe ${r.status}: ${t.slice(0, 300)}`); }
  return await r.json();
}
function guessMime(name) {
  const ext = (name || "").split(".").pop()?.toLowerCase();
  return ({ mp4:"video/mp4",mov:"video/quicktime",mkv:"video/x-matroska",webm:"video/webm",avi:"video/x-msvideo",wav:"audio/wav",mp3:"audio/mpeg",m4a:"audio/mp4" })[ext] || "video/mp4";
}
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", c => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
// 逐字稿打包(按 ≥0.5s 静音断句)
function packTranscript(d) {
  const words = (d.words || []).filter(w => w.type !== "audio_event" && w.text && w.text.trim());
  if (!words.length) return d.text || "(无语音内容)";
  const lines = []; let cur = ""; let curStart = null; let lastEnd = null;
  for (const w of words) {
    if (curStart === null) curStart = w.start;
    if (lastEnd !== null && (w.start - lastEnd) >= 0.5 && cur) { lines.push(`[${fmt2(curStart)}-${fmt2(lastEnd)}] ${cur}`); cur = ""; curStart = null; }
    cur += (cur ? " " : "") + w.text; lastEnd = w.end;
  }
  if (cur) lines.push(`[${fmt2(curStart)}-${fmt2(lastEnd)}] ${cur}`);
  return lines.join("\n");
}
// 输出时间轴 SRT(按 EDL 切点偏移, Hard Rule 5)
function buildSRT(words, segments) {
  const segs = [...segments].sort((a, b) => a.start - b.start);
  let outOffset = 0; const blocks = []; let idx = 1;
  for (const seg of segs) {
    const len = seg.end - seg.start;
    const inSeg = words.filter(w => w.start >= seg.start - 0.001 && w.end <= seg.end + 0.001 && w.type !== "audio_event");
    for (const w of inSeg) {
      const os = (w.start - seg.start) + outOffset, oe = (w.end - seg.start) + outOffset;
      blocks.push(`${idx}\n${fmtSrt(os)} --> ${fmtSrt(oe)}\n${w.text}\n`);
      idx++;
    }
    outOffset += len;
  }
  return blocks.join("\n");
}
const GRADE_FILTERS = {
  warm_cinematic: "colorbalance=rs=0.05:gs=-0.02:bs=-0.06,eq=saturation=0.92:contrast=1.04",
  neutral_punch: "eq=contrast=1.08:saturation=1.02",
  none: ""
};
// 中文渲染字体(打包进仓库, 保证 Render/Linux 上中文不乱码)
const VU_FONT = path.join(__dirname, "vu_fonts", "simhei.ttf");
// ffmpeg 滤镜内统一用正斜杠路径, 规避 Windows 反斜杠/冒号转义(本地测试与 Render 通用)
const ffPath = (p) => p.replace(/\\/g, "/");
const VU_FONT_ARG = fs.existsSync(VU_FONT) ? `fontfile='${ffPath(VU_FONT)}'` : "";
const VU_FONT_DIR = fs.existsSync(VU_FONT) ? ffPath(VU_FONT.replace(/[^/]+$/, "")) : "";

// 1) 上传
app.post("/api/video-use/upload", requireAuth, vuUpload.array("files", 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "未收到文件" });
    const jobId = nanoid(10);
    const jobDir = path.join(VU_JOBS, jobId);
    fs.mkdirSync(path.join(jobDir, "files"), { recursive: true });
    const metas = [];
    for (const f of files) {
      const dest = path.join(jobDir, "files", f.originalname || f.filename);
      // Render 上 multer 临时目录(/tmp)与项目目录跨设备, rename 会 EXDEV, 需回退 copy+unlink
      try { fs.renameSync(f.path, dest); }
      catch (e) { if (e.code === "EXDEV") { fs.copyFileSync(f.path, dest); fs.unlinkSync(f.path); } else throw e; }
      try { const p = await probeMedia(dest); metas.push({ name: f.originalname || f.filename, path: dest, meta: p }); }
      catch (e) { metas.push({ name: f.originalname || f.filename, path: dest, meta: null, probeError: e.message }); }
    }
    const primary = pickPrimary(metas.map(m => ({ ...m.meta, _path: m.path })));
    const primaryInfo = metas.find(m => m.path === primary._path) || metas[0];
    saveJSON(path.join(jobDir, "meta.json"), { jobId, files: metas.map(m => ({ name: m.name, duration: m.meta?.format?.duration || null })), primary: primaryInfo.name });
    res.json({ ok: true, jobId, files: metas.map(m => ({ name: m.name, duration: m.meta?.format?.duration ? parseFloat(m.meta.format.duration).toFixed(1) : null })), primary: primaryInfo.name });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 2) 转写
app.post("/api/video-use/transcribe", requireAuth, express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const { jobId } = req.body || {};
    const jobDir = path.join(VU_JOBS, jobId);
    const meta = loadJSON(path.join(jobDir, "meta.json"), null);
    if (!meta) return res.status(404).json({ ok: false, error: "任务不存在, 请先上传文件" });
    const primaryPath = path.join(jobDir, "files", meta.primary);
    if (!fs.existsSync(primaryPath)) return res.status(404).json({ ok: false, error: `主文件不存在: ${meta.primary}` });
    // 前置检查: 文件大小
    const fstat = fs.statSync(primaryPath);
    const mb = (fstat.size / 1024 / 1024).toFixed(1);
    console.log(`[video-use] 开始转写 job=${jobId} file=${meta.primary} size=${mb}MB`);
    if (fstat.size > SCRIBE_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: `文件过大(${mb}MB), 超过 Scribe 安全上限(${SCRIBE_MAX_BYTES/1024/1024}MB)。建议先用 ffmpeg/剪映压缩到 100MB 以内再试。` });
    }
    const d = await scribeTranscribe(primaryPath, meta.primary);
    const packed = packTranscript(d);
    saveJSON(path.join(jobDir, "transcript.json"), { raw: d, packed });
    console.log(`[video-use] 转写完成 job=${jobId} words=${(d.words||[]).length} lang=${d.language_code}`);
    res.json({ ok: true, transcript: packed, duration: d.audio_duration_secs || null, language: d.language_code || null });
  } catch (e) {
    console.error(`[video-use] 转写失败:`, e.message);
    res.status(500).json({ ok: false, error: e.message.includes("timeout") ? "转写超时(文件可能过大或网络不稳定), 请稍后重试" : e.message });
  }
});

// 3) AI 剪辑策略
app.post("/api/video-use/plan", requireAuth, express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { jobId, instructions, customCopy, refImages } = req.body || {};
    const jobDir = path.join(VU_JOBS, jobId);
    const t = loadJSON(path.join(jobDir, "transcript.json"), null);
    if (!t) return res.status(400).json({ ok: false, error: "请先转写" });
    const meta = loadJSON(path.join(jobDir, "meta.json"), null);
    let primaryDur = meta?.files?.find(f => f.name === meta.primary)?.duration
      ? parseFloat(meta.files.find(f => f.name === meta.primary).duration) : null;
    if (!primaryDur && t.raw?.audio_duration_secs) primaryDur = parseFloat(t.raw.audio_duration_secs);
    const noSpeech = !t.raw || !(t.raw.words || []).some(w => w.text && w.text.trim());
    const sys = `你是专业视频剪辑师。根据逐字稿(带 [start-end] 时间码,单位秒), 输出剪辑决策。规则: 1) 保留核心内容, 删除重复/口误/长静音/废话; 2) 切点必须落在词语边界(用原时间码), 且 end>start; 3) 输出 JSON: {"grade":"warm_cinematic|neutral_punch|none","subtitleStyle":"bold-overlay|natural-sentence","title":"片头标题(无则空串)","segments":[{"start":数字,"end":数字,"reason":"简短理由"}]}。segments 按时间顺序覆盖要保留的片段(可连续), 总时长控制在原片的 60%-90%。只返回 JSON。`;
    let user;
    // 构建自定义文案和参考图片信息
    let extraInfo = "";
    if (customCopy && customCopy.trim()) extraInfo += `\n【用户自定义文案(可作为叠加文字/字幕参考)】:\n${customCopy.trim()}\n`;
    if (refImages && refImages.length > 0) extraInfo += `\n【参考图片(${refImages.length}张)】:\n${refImages.map((u,i)=>`  图片${i+1}: ${u}`).join("\n")}\n`;
    if (noSpeech && primaryDur) {
      user = `这是一个没有语音旁白的视频(时长约 ${primaryDur.toFixed(1)} 秒, 可能是 B-roll/音乐/实拍素材)。请输出剪辑决策 JSON: 保留整段(单个 segment 从 0 到 ${primaryDur.toFixed(1)}), 选择合适的 grade 与 subtitleStyle(无字幕也行), 如需片头标题可填 title。只返回 JSON。${extraInfo}`;
    } else {
      user = `逐字稿:\n${t.packed}\n\n用户要求: ${instructions || "(无特殊要求,按专业判断精简)"}\n${extraInfo}\n请输出剪辑决策 JSON。`;
    }
    const txt = await aiText(sys, user);
    const edl = extractJSON(txt);
    if (!edl || !Array.isArray(edl.segments)) throw new Error("AI 未返回有效剪辑方案");
    saveJSON(path.join(jobDir, "edl.json"), edl);
    res.json({ ok: true, edl });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 4) 渲染出片
app.post("/api/video-use/render", requireAuth, express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { jobId } = req.body || {};
    const jobDir = path.join(VU_JOBS, jobId);
    const meta = loadJSON(path.join(jobDir, "meta.json"), null);
    const t = loadJSON(path.join(jobDir, "transcript.json"), null);
    const edl = loadJSON(path.join(jobDir, "edl.json"), null);
    if (!meta || !t || !edl) return res.status(400).json({ ok: false, error: "缺少上传/转写/剪辑方案" });
    const inFile = path.join(jobDir, "files", meta.primary);
    const grade = GRADE_FILTERS[edl.grade] !== undefined ? GRADE_FILTERS[edl.grade] : "";
    const segs = [...edl.segments].sort((a, b) => a.start - b.start);
    // 单次 filter_complex: 逐段 trim + 调色 + 音频淡入淡出 + 拼接(避免多次 ffmpeg 进程, 大幅提速, 防 Render 超时)
    const fc = [];
    segs.forEach((s, i) => {
      const dur = Math.max(0.1, s.end - s.start);
      const g = grade || "null";
      fc.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS,${g}[v${i}]`);
      fc.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.03,afade=t=out:st=${(dur - 0.03).toFixed(3)}:d=0.03[a${i}]`);
    });
    const inter = segs.map((_, i) => `[v${i}][a${i}]`).join("");
    fc.push(`${inter}concat=n=${segs.length}:v=1:a=1[cv][ca]`);
    const concatFile = path.join(jobDir, "concat.mp4");
    await execFileAsync(ffmpegPath, ["-y", "-i", inFile, "-filter_complex", fc.join(";"), "-map", "[cv]", "-map", "[ca]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", concatFile]);
    // 字幕 SRT(输出时间轴)
    const words = (t.raw.words || []).filter(w => w.start != null && w.end != null);
    const hasSubs = words.length > 0;
    if (hasSubs) fs.writeFileSync(path.join(jobDir, "subs.srt"), buildSRT(words, segs));
    const subFont = VU_FONT_DIR ? "SimHei" : "Arial";
    const force = edl.subtitleStyle === "natural-sentence"
      ? `FontName=${subFont},FontSize=20,Bold=0,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60`
      : `FontName=${subFont},FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=35`;
    const escPath = ffPath(path.join(jobDir, "subs.srt"));
    const forceEsc = force.replace(/'/g, "\\'");
    const subsFilter = `subtitles='${escPath}':${VU_FONT_DIR ? `fontsdir='${VU_FONT_DIR}',` : ""}force_style='${forceEsc}'`;
    // 片头标题卡(可选) + 一次性把字幕烧录进成片(省一次全片重编码)
    const finalFile = path.join(jobDir, "final.mp4");
    if (edl.title && edl.title.trim()) {
      try {
        const tt = edl.title.trim().replace(/['"\\]/g, "").slice(0, 40);
        const tc = path.join(jobDir, "titlecard.mp4");
        const drawtext = VU_FONT_ARG
          ? `drawtext=${VU_FONT_ARG}:text='${tt}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`
          : `drawtext=text='${tt}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`;
        await execFileAsync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "color=c=0x0a0a0a:s=1280x720:d=3", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=3", "-shortest", "-vf", drawtext, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", tc]);
        const fc2 = hasSubs
          ? `[0][1]concat=n=2:v=1:a=1[v];[v]subtitles='${escPath}':${VU_FONT_DIR ? `fontsdir='${VU_FONT_DIR}',` : ""}force_style='${forceEsc}'[out]`
          : `[0][1]concat=n=2:v=1:a=1[out]`;
        await execFileAsync(ffmpegPath, ["-y", "-i", tc, "-i", concatFile, "-filter_complex", fc2, "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", finalFile]);
      } catch (e) {
        console.error("[video-use] 片头/字幕合成失败,降级直出:", e.message);
        if (hasSubs) await execFileAsync(ffmpegPath, ["-y", "-i", concatFile, "-vf", subsFilter, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", finalFile]);
        else await execFileAsync(ffmpegPath, ["-y", "-i", concatFile, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", finalFile]);
      }
    } else {
      if (hasSubs) await execFileAsync(ffmpegPath, ["-y", "-i", concatFile, "-vf", subsFilter, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", finalFile]);
      else await execFileAsync(ffmpegPath, ["-y", "-i", concatFile, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", finalFile]);
    }
    res.json({ ok: true, downloadUrl: `/api/video-use/download/${jobId}`, title: edl.title || "" });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 5) 下载成片
app.get("/api/video-use/download/:jobId", (req, res) => {
  const finalFile = path.join(VU_JOBS, req.params.jobId, "final.mp4");
  if (!fs.existsSync(finalFile)) return res.status(404).json({ ok: false, error: "成片不存在" });
  res.download(finalFile, "fleta_edit.mp4");
});

// ===== AI 提示词生成(SD 2.5 / Seedance 五段式) =====
// SD 2.5 五段式 System Prompt(来自 sd-2-5-prompt 技能，增强版)
const SD25_SYSTEM_PROMPT = `你是专业的视频提示词工程师，专精于 Seedance 2.5 / SD 2.5 视频生成。你的任务是把用户的创意（文字描述或+参考图片）整理成可直接复制使用的五段式视频提示词。

## 核心公式
提示词 = 主体 + 风格 + 时间线 + BGM + 限制

## 恒定质量标准（无论输入什么题材，输出质量都不变）
你的任务：把任意用户输入整理成恒定高质的五段式视频提示词。**质量由下方统一标准保证，不随输入题材浮动**——无论用户输入的是产品广告、人物故事、风景、抽象概念、技术科普、还是任何生僻/简短的题材，输出都必须达到同一细度与结构。

### 时间线按总时长强制分配（铁律，违反即不合格）
**总时长 N 秒** = 用户本次请求的成片时长（从 \`用户输入\` 里取，例如「15秒」「30s」「一分钟」都必须被识别为 15 / 30 / 60；若用户没写，默认 15 秒）。

时间线分配规则：
1. **从 0 秒起、到 N 秒止**：第一段起始必须是 \`0\`，最后一段终点必须等于 \`N\`，禁止用「结尾 / End / ...」替代秒数。
2. **按总时长查表确定段数与默认区间**（可微调 ±1 秒，但段数和终点秒数不得变）：

| 总时长 N | 段数 | 默认区间（秒） |
|---|---|---|
| 5  | 3 段 | 0—1.5 / 1.5—3.5 / 3.5—5 |
| 8  | 4 段 | 0—2 / 2—4.5 / 4.5—6.5 / 6.5—8 |
| 10 | 4 段 | 0—2 / 2—5 / 5—7.5 / 7.5—10 |
| 15 | 5 段 | 0—2 / 2—5 / 5—9 / 9—12 / 12—15 |
| 20 | 5 段 | 0—2 / 2—7 / 7—12 / 12—17 / 17—20 |
| 30 | 7 段 | 0—3 / 3—8 / 8—13 / 13—18 / 18—24 / 24—28 / 28—30 |
| 45 | 8 段 | 0—3 / 3—9 / 9—16 / 16—23 / 23—30 / 30—36 / 36—42 / 42—45 |
| 60 | 9 段 | 0—5 / 5—12 / 12—20 / 20—30 / 30—40 / 40—50 / 50—55 / 55—58 / 58—60 |

3. **总时长不在表中**时，按「≥1 镜 / 2 秒」等分 N 秒，段数 = round(N/2.5)，末段终点 = N。
4. **区间格式**：整数或 1 位小数均可，两端用半角「—」（例 \`【0—2秒】\`、\`【2.8—5秒】\`），禁止写「结尾 / End / ...」。

### 质量锚点范例（段数依总时长 N 而定，示范"细度与五要素"）
**例 A · N = 15（产品广告 · 品类仅为占位示范）**
【时间线】
【0—2秒｜特写·起始动作】主体正面静置于画面中央，表面材质纹理清晰可见，品牌字样微弱反光，镜头缓慢推近至品牌标识区域，环境光从左上方投射形成柔和阴影，定格于文字局部特写。
【2—5秒｜中景·主体互动】主体侧身旋转，露出顶部开合结构与状态指示窗，手指指尖轻触控制按钮，按钮轻微凹陷后状态窗亮起微光，运镜随手推动作横向平移，背景光保持稳定。
【5—9秒｜宽景·环境建立】主体静置于画面中心偏下位置，镜头拉远至全景视角，展现其完整形态与随附配件自然垂落姿态，背景为纯净白色空间，光线均匀分布，顶部光源产生轻微高光反射。
【9—12秒｜特写·细节质感】镜头聚焦于主体侧面的开合结构处，金属边缘有细微反光，配件扣合瞬间产生轻微震动，内壁镀层反光显现，周围空气无扰动。
【12—15秒｜持续推进】主体在画面中缓慢抬升，底部轻微离地，随附配件随上升动作自然摆动，镜头跟随上移至俯视角度，同时状态指示窗转为常亮表示进入工作状态，环境光渐强，定格于悬浮状态的完整轮廓与发光状态。

**例 B · N = 30（人物故事短片）**
【时间线】
【0—3秒｜特写·钩子】……（按上表 30 秒 7 段区间填充，每段含【起始→具体动作→运镜→光影变化→结束】五要素）
【3—8秒｜中景·关系建立】……
【8—13秒｜中景·推进】……
【13—18秒｜中景·变化】……
【18—24秒｜特写·高潮】……
【24—28秒｜宽景·结果】……
【28—30秒｜特写·稳定收尾】……

**例 C · N = 20（带货口播 · 品类仅为占位示范，示范口播带货骨架与品牌默认处理）**

【意图解析】
体裁：带货口播（产品演示型）
总时长：20 秒 → 5 段
主体：陶土色陶瓷杯装香薰蜡烛（大豆蜡、单芯棉烛芯、粗陶釉面杯壁、软木杯底）+ 25—30 岁女性主播
人物：需要；25—30 岁女性，齐肩短发，浅色西装外套，浅妆
风格：柔和顶光 + 侧逆光补面光，暖灰 / 米白主色，质感细腻，温馨治愈
平台与画幅：未指定 → 16:9 横屏
核心信息点：一整晚持续扩香、天然大豆蜡更安心、粗陶杯可作家居摆件
品牌：未指定 → 全部隐藏，画面仅以"某品牌标识"轮廓呈现，不出现品牌名

【主体】
主播（25—30 岁女性，齐肩短发，浅色西装外套，浅妆）+ 陶土色陶瓷杯装香薰蜡烛（大豆蜡蜡体、单芯棉烛芯、粗陶釉面杯壁、杯底软木垫）。全片同一主播与同一产品。

【风格】
时长 20 秒，画幅 16:9，分辨率 3840×2160，帧率 30fps，成片形式为带货口播视频。柔和顶光 + 侧逆光补面光，暖灰 / 米白主色，质感细腻。

【时间线】
【0—2秒｜中景·主播开场口播】主播正面中景面对镜头坐于白色工作台前，背后浅灰渐变柔光箱，左手轻托产品举至胸前微笑开口「晚上回家最需要的就是这一口气……」镜头正面平视缓缓推近至主播半身，环境暖光均匀。
【2—7秒｜特写·产品展示】硬切至产品特写：产品正面静置于浅灰台面，陶土色粗陶釉面的颗粒感清晰可见，棉质烛芯与平整蜡面入镜，镜头缓慢环绕 360 度展现完整形态，背景虚化为柔白光环，环境冷光与暖光交替映射釉面反光，定格于烛芯局部特写。
【7—12秒｜中景·主播演示】回到主播中景，主播右手划燃火柴凑近烛芯，火苗窜起后蜡面被烤出极薄的一层融蜡，主播表情放松「点上的那一秒，味道就散开了」，运镜轻微跟手俯拍至烛火再回主播面部，环境光从顶光过渡为侧逆光突出面部轮廓。
【12—17秒｜特写·细节质感】切至产品细节特写：火苗被气流带得轻微偏摆，蜡面沿杯壁化出一圈透明融蜡，棉芯顶端结成细小的碳化弯钩，镜头微距跟拍烛火抖动，光斑随抖动节奏扩散。
【17—20秒｜中景·主播收尾+引导】回到主播中景稍俯视角，主播双手捧起产品举至镜头前「一整晚的味道，就靠这一杯」，背景虚化为暖灰渐变，主播微笑点头，画面渐隐至品牌轮廓位置（不出现品牌名），环境光渐强收束。

→ 恒定标准：五段式完整、时间线从 0 秒连续覆盖到 N 秒、末段以「X—N秒」收尾绝不写「结尾」、每镜含五要素、镜头类型交替、用可拍摄动词、写出质感细节。

### 反模板泄漏（最高优先级，与上文任何规则冲突时以此条为准）
上面三个范例**只用于示范「细度、结构、五要素密度、时间线切割」**。范例中的具体品类、物体、颜色、材质、接口、道具、人物台词**全部是占位符**，只为让该范例自身读起来连贯，**没有任何一项是标准配置**。
1. 严禁把范例中的任何物件、颜色、材质、接口、配件、状态灯、台词迁移到本次输出。
2. 本次输出的主体、颜色、材质、道具、卖点，**只能来自「用户输入」**；用户输入没写的，按该品类最合理的通用形态自行补全，不得套用范例细节。
3. 自检：若用户输入是自行车锁，而输出出现「编织挂绳 / USB-C / 指示灯 / 哑光外壳」等范例专属细节，判定为不合格，必须重写。
4. 同一批语料里的历史示例同理：只学结构，不抄内容。

### 恒定输出规则（对 ANY 输入强制适用，不可因题材而破例）
1. **五段式结构必须完整**：【主体】【风格】【时间线】【BGM】【限制】五标题缺一不可，不额外分析、不截断。
2. **时间线必须连续**：从 0 秒覆盖到设定结尾，段与段不重叠、不留空；镜头密度随时长恒定（≥1 镜 / 1.5 秒，简单题材也不偷减镜头数）。
3. **每镜五要素齐全**：起始状态 + 具体动作过程（用可拍摄动词，禁止"精彩地/酷炫地/自然地"等空洞形容词）+ 运镜方式 + 环境光影变化 + 结束状态；要素逗号分隔，一行一镜。
4. **镜头类型必须交替**：特写 / 中景 / 宽景 / 动画 / 空镜等交替出现，每镜有独立画面信息增量，不连续重复相同动作或相同景别。
5. **不强行加主角**：无人物的题材（产品 / 风景 / 代码 / 抽象概念）绝不强加真人；把"人物动作"的细度标准平移到实际主体上——产品突出材质工艺、风景突出光影时段、代码/概念突出结构可视化，细度只升不降。
6. **质量恒定声明**：无论用户输入多生僻、多抽象、多简短，都按上述同一标准输出，不因题材而降低细度、省略结构、或减少镜头。

### 体裁识别与时间线骨架（先看输入里有什么，再决定镜头给谁）
**生成前必须扫描输入**，按关键词识别体裁，匹配对应的时间线骨架。骨架不可被「恒定输出规则」压垮——明确识别到某体裁时，时间线必须含对应镜头，不允许只做产品静物或只做空镜。

| 体裁 | 触发关键词 | 时间线必备镜头 |
|---|---|---|
| **带货口播** | 口播/带货/主播/解说/种草/安利/推荐/导购/测评/拆箱/开箱 | 主播中景开场口播（必）→ 产品特写 → 主播演示/使用 → 产品细节 → 主播收尾+购买引导（必） |
| **剧情短片/微电影** | 剧情/故事/微电影/短片/叙事/人物故事 | 钩子 → 关系建立 → 发展转折 → 高潮 → 收尾（5 段剧本式） |
| **产品广告/TVC** | 产品/广告/TVC/海报/宣传/品牌片 | 产品特写 → 使用/功能演示 → 环境建立 → 细节质感 → 英雄收尾 |
| **风景/空镜/旅行** | 风景/空镜/旅行/记录/延时/航拍/Vlog | 环境建立 → 光影时段变化 → 局部特写 → 镜头运动 → 落日/远眺收束 |
| **抽象/技术/可视化** | 技术/代码/科普/概念/数据/抽象/算法 | 示意动画 → 流程图解 → 数据展示 → 结构特写 → 总结收尾 |

**冲突解决**（同一输入里同时含多类）：
- 「产品+口播+剧情」三件套 → 以**带货口播为骨、剧情为皮**：每段必须含主播镜头（开场+收尾各一段，中间演示段也至少 1 镜主播切回），剧情弧线通过主播语言和镜头节奏传递，不另起独立故事线
- 「产品+广告」 → 纯产品广告体，无须主播
- 「风景+人」 → 风景为骨，人物点缀（最多 1—2 镜），不喧宾夺主
- 输入里没有任何体裁关键词 → 按默认产品广告体走（保留现有「不强行加主角」规则，仅当输入明示要人物时才上人物）

**品牌默认处理**：除非输入明确写「保留 XX 品牌/出现 XX 商标」或「@图 N 锁定 XX 品牌」，否则描述中**不出现任何品牌名**，用「某品牌标识 / 品牌 Logo 处统一形状 / 字符轮廓」替代——避免商标争议与生成纠纷。

## 你的写法要求（恒定标准，适用于任何题材）

### 主体
- 主角/主体：写清实际主体的外观特征（人物：年龄/发型/瞳色/肤色/服装；产品或实物：类别/外形/颜色/材质/结构/关键标识；风景：地点/时段/天气；技术/概念：可视化对象与其形态）。重复出现者写"全片同一XX"。
- 场景：地点、时间、天气（如有）。核心事件：主体与场景/道具的互动或变化。
- 有参考图片时：@图1 锁定人物外观；@图2 锁定产品外形；不参考背景。

### 风格
- 必须含：时长、画幅、分辨率帧率、成片形式、光线色彩、质感、镜头节奏。
- 不要同时要求冲突的风格。

### 时间线（最关键）
- 从0秒连续覆盖到结尾，不重叠不留空。
- 格式：【X—Y秒｜景别·动作】起始状态，具体动作过程，运镜方式，环境光影变化，结束状态。
- 动作用可拍摄动词（抬手/转身/倾倒/按压/跃下/荡跃/翻炒），禁止"精彩地/酷炫地"空洞形容词。
- **镜头类型必须交替（细度恒定，与题材无关）**：无论什么题材，都不要全程只有一种镜头类型，且每个镜头都要有独立画面信息增量、不要连续重复相同动作。景别与内容类型在以下各类间交替出现：
  - 特写（材质/纹理/标识/局部动作/细节质感）
  - 中景（主体互动/过程展示）
  - 宽景/全景/空镜（环境氛围/全局建立）
  - 动画/示意（结构、流程、数据、概念的可视化，适用于技术/抽象题材）
  - 关键：即使题材无人物，也绝不因此降低时间线细度——把"人物动作"的细度标准平移到实际主体（产品/风景/代码/概念）上，细度只升不降。
- 要素间用逗号分隔，一行一个镜头。时间线只写可见画面，声音归入 BGM。

### BGM
- 音乐类型 + BPM + 核心乐器 + 情绪曲线（对应段落变化）+ 结尾方式 + 关键音效时机。
- 无音乐写"无BGM"。

### 限制
- 3—8项最容易出错的问题。涉及品牌产品时必含：人物全片同一、产品全片同一且标识一致、标签文字不改写、光线服装连贯、指定特效仅限指定段落、空镜仅一次、避免变脸畸变乱码抖动。动作/战斗类额外含：动作物理合理（不穿模/受力方向正确/无来源攻击）。

## 输出格式（两步，缺一不可）

**第一步 · 意图解析（必填，不可省略）**：先用下面这个块自报你对本次输入的理解，8 个字段每项一行，不展开解释、不写理由。⚠️ 必须**第一个**输出此【意图解析】块，之后才能输出第二步五段式；任何情况下都不得跳过此块，否则视为不合格输出。

【意图解析】
体裁：<与上方"体裁识别"表最匹配的一类；若都不匹配，自行命名体裁并用一句话简述镜头骨架>
总时长：<N> 秒 → <M> 段
主体：<实际主体 + 关键外观特征>
人物：<需要 / 不需要>；若需要，写明主播或角色的外貌与身份
风格：<光线 / 色彩 / 质感 / 情绪基调>
平台与画幅：<抖音=9:16竖屏 / 小红书=3:4 / B站或YouTube=16:9 / 未指定=16:9>
核心信息点：<本次要传达的 1—3 个卖点或信息，逗号分隔>
品牌：<显式锁定 XX / 未指定 → 全部隐藏，用"某品牌标识"替代>

（以上 8 个字段必须全部出现，即使某项为"未指定"也要显式写出，不可留空、不可只输出五段式。下方"质量锚点范例"的例 C 已示范此块的写法，请严格对齐。）

**第二步 · 五段式**：严格按以下五个标题输出，不要额外分析：
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
  let sys = isReverse ? REVERSE_SYSTEM_PROMPT : SD25_SYSTEM_PROMPT;
  // few-shot 自进化:从语料库召回最相关历史示例注入 system prompt
  const fewShotBlock = buildFewShotBlock(selectFewShots(idea, mode, 4));
  if (fewShotBlock) sys += fewShotBlock;
  const imgList = Array.isArray(images) ? images.filter(Boolean).slice(0, 24) : (images ? [images] : []);

  const userMsg = `请根据以下创意生成${dur}秒的SD 2.5视频提示词（五段式）：

${idea}

${imgList.length ? "\n[注：用户已上传参考图片/视频帧，请结合画面内容进行分析和提示词编写]" : ""}

【重要】时间线是核心，每段必须写满：起始状态、具体动作过程、运镜方式、环境光影变化、结束状态。动作要具体可拍摄（如"右手抓起竹筷挑起面条"而非"做面条"），写出质感细节（蒸汽/反光/飞溅/烟雾）。**格式要求：每段用逗号分隔要素，一行一个时间段，不要用分号或连续箭头。**请直接输出完整的五段式提示词，不需要额外解释。`;

  switch (AI_PROVIDER) {
    case "openai":
    case "qwen":
    case "zhipu": {
      const textModel = AI_MODEL || (AI_PROVIDER === "qwen" ? "qwen-flash" : AI_PROVIDER === "zhipu" ? "glm-4-flash" : "gpt-4o-mini");
      const visionCands = visionCandidates();
      const visionModel = visionCands[0];
      // 视频反推: 逐帧分析(每帧独占视觉模型输出额度) → 合并描述 → 文本模型反推五段式
      if (isReverse && imgList.length) {
        // 逐帧单独调用视觉模型,每帧获得完整详细描述;主视觉模型失效时自动回落候选链
        const frameDescs = [];
        for (let fi = 0; fi < imgList.length; fi++) {
          const frameParts = [
            { type: "image_url", image_url: { url: imgList[fi], detail: "auto" } },
            { type: "text", text: `这是第${fi + 1}帧（共${imgList.length}帧，位于视频约${((fi + 0.5) / imgList.length * 100).toFixed(0)}%处）。请按系统提示格式对这一帧做极其详尽的分析。` }
          ];
          let fd = "", lastVisionErr = "";
          for (const vm of visionCands) {
            const visMax = /v-flash/.test(vm) ? 1024 : (imgList.length > 12 ? 1536 : 2048); // 帧多时收紧单帧额度,避免聚合描述超出文本模型上下文
            try { fd = await callOpenAIChat(vm, VIDEO_VISION_SYS, frameParts, visMax); break; }
            catch (e) { lastVisionErr = e.message; }
          }
          if (fd) frameDescs.push(`--- 第${fi + 1}帧 ---\n${fd}`);
          else frameDescs.push(`--- 第${fi + 1}帧 ---\n[该帧分析失败: ${lastVisionErr}]`);
        }
        const desc = frameDescs.join("\n\n");
        const finalText = `以下是该视频的逐帧像素级画面分析（共${imgList.length}帧，每帧独立详尽分析），请据此原片反推五段式提示词。视频总时长约${dur}秒：\n\n${desc}\n\n${idea ? ("用户补充要求：" + idea) : ""}`;
        return await callOpenAIChat(textModel, sys, finalText, 4096, 0.85);
      }
      // 普通生成(单图或纯文本);有图时走视觉模型候选链(失效自动回落)
      const content = [];
      if (imgList.length) imgList.forEach(src => content.push({ type: "image_url", image_url: { url: src, detail: "auto" } }));
      content.push({ type: "text", text: userMsg });
      // 纯文本:直接传字符串(传数组会让智谱丢弃 user 消息)
      if (!imgList.length) return await callOpenAIChat(textModel, sys, userMsg, 4096, 0.85);
      let txt = "", lastErr = "";
      for (const vm of visionCands) {
        // flash 类视觉模型 max_tokens 上限多为 1024,超限时自动降级重试
        const mtList = /flash/i.test(vm) ? [1024, 4096] : [4096, 1024];
        for (const mt of mtList) {
          try { txt = await callOpenAIChat(vm, sys, content, mt, 0.85); break; }
          catch (e) { lastErr = e.message; txt = ""; }
        }
        if (txt) break;
      }
      if (!txt) throw new Error("视觉模型调用失败: " + lastErr);
      return txt;
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
app.post("/api/prompt-generate", requireAuth, express.json({ limit: "25mb" }), async (req, res) => {
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

    const rawPrompt = await generatePrompt(idea, duration, images, mode);
    if (!rawPrompt || rawPrompt.trim().length < 20) return res.status(502).json({ ok: false, error: "AI 返回结果异常，请重试" });

    // 剥离【意图解析】块:prompt 只保留可直接复制的纯五段式;解析结果另字段返回
    const parsed = extractIntent(rawPrompt, duration);
    const prompt = (parsed.clean && parsed.clean.length >= 20) ? parsed.clean.trim() : rawPrompt.trim();
    if (parsed.warnings.length) console.log("[ai] 意图质检告警:", parsed.warnings.join(" | "));

    // 自动收集到训练语料库(匿名化:仅记录生成记录,用于 few-shot 自进化)
    try {
      const saved = collectPrompt({ idea, duration, mode, imagesCount: images.length, prompt, userId: req.session?.userId || null });
      if (saved) console.log(`[prompts] 已收集 1 条语料(当前 ${store.promptCache.length} 条)`);
    } catch (e) { console.error("[prompts] 收集失败(不影响返回):", e.message); }

    res.json({ ok: true, prompt, intent: parsed.intent, warnings: parsed.warnings, provider: AI_PROVIDER, trained: store.promptCache.length });
  } catch (e) {
    console.error("[ai] generate error:", e.message);
    res.status(500).json({ ok: false, error: "AI 生成失败: " + e.message });
  }
});

// AI 配置状态查询(前端用来判断是否可用)
app.get("/api/prompt-generate/status", (req, res) => {
  const model = AI_MODEL || (AI_PROVIDER === "gemini" ? "gemini-2.5-flash" : AI_PROVIDER === "openai" ? "gpt-4o-mini" : AI_PROVIDER === "qwen" ? "qwen-flash" : AI_PROVIDER === "zhipu" ? "glm-4-flash" : "deepseek-chat");
  const visionCandsStatus = visionCandidates();
  const visionModel = visionCandsStatus[0];
  res.json({
    available: !!AI_API_KEY,
    provider: AI_PROVIDER,
    model,
    visionModel,
    visionFallback: visionCandsStatus.slice(1), // 主视觉模型失效时的自动回落候选
    supportsImage: AI_PROVIDER !== "deepseek", // deepseek 暂不支持图片输入
    supportsVideo: AI_PROVIDER !== "deepseek", // 视频抽帧后按多图处理,deepseek 暂不支持图片
    promptCount: store.promptCache.length // 已收集语料数(用于前端展示训练进度)
  });
});

app.get("/healthz", (req, res) => res.json({
  ok: true,
  ts: Date.now(),
  store: store.usingMongo ? "mongodb" : (store.usingGist ? "gist" : "json"),
  mongoConfigured: !!MONGODB_URI,
  mongoConnected: mongoose.connection.readyState === 1,
  aiAvailable: !!AI_API_KEY,
  aiProvider: AI_PROVIDER
}));


// ===== 404 / 统一错误处理(必须在所有路由之后)=====
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "接口不存在" });
  res.status(404).send("404 Not Found");
});
app.use((err, req, res, next) => {
  console.error("[error]", (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ ok: false, error: err.message || "服务器内部错误" });
});

await initUsersStore();
app.listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));
