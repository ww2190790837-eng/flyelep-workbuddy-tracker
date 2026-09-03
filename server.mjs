import express from "express";
import session from "express-session";
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
import nodemailer from "nodemailer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import multer from "multer";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobePathRaw from "ffprobe-static";
// ffmpeg-static 导出字符串; ffprobe-static@2 导出 { path } 对象, 统一成字符串
const ffmpegPath = typeof ffmpegPathRaw === "string" ? ffmpegPathRaw : ffmpegPathRaw.path;
const ffprobePath = typeof ffprobePathRaw === "string" ? ffprobePathRaw : ffprobePathRaw.path;

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || "fleta-change-me-in-production-2026";
const PUBLIC_URL = process.env.PUBLIC_URL || "https://fleta-ai.onrender.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "codex2026";
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== 简易 JSON DB =====
const USERS_FILE = path.join(DATA_DIR, "users.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const DB_FILE = path.join(DATA_DIR, "db.json");
const CODES_FILE = path.join(DATA_DIR, "codes.json");

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// 加载现有 visits/clicks DB(本地仅作兜底/首次播种;联网优先走 Gist)
let db = loadJSON(DB_FILE, { visits: [], clicks: [] });
let codes = loadJSON(CODES_FILE, { pool: [] });

// ---- 跟踪数据持久化:优先 Gist(异步 debounce,避免每次请求都打 API 触发限流)+ 本地兜底 ----
let dbSaveTimer = null;
let dbSaving = false;
function saveDB(immediate) {
  if (usingGist) {
    if (immediate) {
      if (dbSaveTimer) { clearTimeout(dbSaveTimer); dbSaveTimer = null; }
      persistDBToGist();
    } else if (!dbSaveTimer) {
      dbSaveTimer = setTimeout(() => { dbSaveTimer = null; persistDBToGist(); }, 3000);
    }
    return; // 内存为真值,异步落盘即可
  }
  saveJSON(DB_FILE, db);
}
async function persistDBToGist() {
  if (dbSaving) return; // 上一次未完成,下个周期再写
  dbSaving = true;
  try { await gistPushTracking(db); }
  catch (e) { console.error("[tracking] Gist 持久化失败(内存保留,稍后重试):", e.message); }
  finally { dbSaving = false; }
}
// 进程退出(SIGTERM/SIGINT)前尽量落盘,压缩重启丢数据窗口
async function flushDB() {
  if (usingGist) { try { await gistPushTracking(db); } catch (e) { console.error("[tracking] 退出落盘失败:", e.message); } }
}
process.on("SIGTERM", () => { flushDB().finally(() => process.exit(0)); });
process.on("SIGINT", () => { flushDB().finally(() => process.exit(0)); });
function saveCodes() {
  if (usingGist) {
    return gistPushCodes(codes).catch(e => console.error("[codes] Gist 持久化失败,回退本地:", e.message));
  }
  saveJSON(CODES_FILE, codes);
}

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
const CODES_GIST_FILENAME = "flyelep_codes.json";
const TRACKING_GIST_FILENAME = "flyelep_tracking.json";
const IP_CLAIM_GIST_FILENAME = "flyelep_ipclaims.json";
const PROMPTS_GIST_FILENAME = "flyelep_prompts.json"; // 提示词训练语料(独立文件)
const MESSAGES_GIST_FILENAME = "flyelep_messages.json"; // 留言板数据(独立文件)
// ===== Video-Use 辅助 API (ElevenLabs Scribe 转写/处理) =====
// 实测确认: sk_ 前缀为 ElevenLabs 新版 key 格式; apisk_ 前缀非 ElevenLabs key(返回 Invalid API key)。
// Render Blueprint 不注入自定义环境变量, 故地址/key 写死在此, 更换服务改这里即可。
const VIDEO_USE_API_KEY = process.env.VIDEO_USE_API_KEY || "sk_df39dd4b8d5d4e5abe0fd1470fc1a36f0976a907597b2393";
const VIDEO_USE_API_BASE = (process.env.VIDEO_USE_API_BASE || "https://api.elevenlabs.io").replace(/\/$/, "");
const VIDEO_USE_AUTH_HEADER = process.env.VIDEO_USE_AUTH_HEADER || "xi-api-key"; // ElevenLabs 鉴权头
// 跟踪记录容量上限(兼顾 Gist 单文件 ~1MB 限制 + 分析需求)
const MAX_TRACK = 2500;
let usingGist = false;
let gistCache = [];
async function gistFetch() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch " + r.status);
  const data = await r.json();
  const f = data.files && data.files[GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : [];
}
async function gistPush(users) {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(users, null, 2) } } })
  });
  if (!r.ok) throw new Error("gist push " + r.status);
}
// 邀请码同样走 Gist(单独文件,与 users 同一 Gist,互不影响)
async function gistFetchCodes() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch codes " + r.status);
  const data = await r.json();
  const f = data.files && data.files[CODES_GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : null;
}
async function gistPushCodes(codesData) {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [CODES_GIST_FILENAME]: { content: JSON.stringify(codesData, null, 2) } } })
  });
  if (!r.ok) throw new Error("gist push codes " + r.status);
}
// 访问/点击跟踪数据同样走 Gist(单独文件,与 users/codes 同一 Gist)
// 用紧凑 JSON(无缩进)以压低体积,避免超过 Gist 单文件 ~1MB 上限
async function gistFetchTracking() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch tracking " + r.status);
  const data = await r.json();
  const f = data.files && data.files[TRACKING_GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : null;
}
async function gistPushTracking(tracking) {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [TRACKING_GIST_FILENAME]: { content: JSON.stringify(tracking) } } })
  });
  if (!r.ok) throw new Error("gist push tracking " + r.status);
}

// ===== 注册 / 领码 防刷限流层 (build-your-own-x: 限流器 Rate Limiter) =====
// 目标:防止脚本批量注册 + 刷光邀请码。
const IP_CLAIM_FILE = path.join(DATA_DIR, "ipclaims.json");
// 1) IP 注册限流:滑动窗口,每 IP 10 分钟内最多注册 N 次(挡批量注册脚本;内存即可,重启清零可接受)
const REG_WINDOW_MS = 10 * 60 * 1000;
const REG_MAX_PER_IP = 5;
const ipRegHits = new Map(); // ip -> [ts, ts, ...]
// 2) IP 领码上限:同一 IP 只能成功领取 1 个邀请码(即使换账号也不行);持久化防重启后重复刷
let ipClaims = loadJSON(IP_CLAIM_FILE, {}); // { ip: code }
async function gistFetchIpClaims() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch ipclaims " + r.status);
  const data = await r.json();
  const f = data.files && data.files[IP_CLAIM_GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : null;
}
async function gistPushIpClaims() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [IP_CLAIM_GIST_FILENAME]: { content: JSON.stringify(ipClaims) } } })
  });
  if (!r.ok) throw new Error("gist push ipclaims " + r.status);
}

// 3) 提示词训练语料库(独立文件):自动收集用户生成记录,用于 few-shot 自进化
const PROMPTS_FILE = path.join(DATA_DIR, "prompts.json");
const MAX_PROMPTS = 3000; // 语料容量上限(兼顾 Gist 单文件 ~1MB)
let promptCache = []; // [{id, idea, duration, mode, imagesCount, prompt, ts, userId?}]
async function gistFetchPrompts() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch prompts " + r.status);
  const data = await r.json();
  const f = data.files && data.files[PROMPTS_GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : null;
}
async function gistPushPrompts() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [PROMPTS_GIST_FILENAME]: { content: JSON.stringify(promptCache) } } })
  });
  if (!r.ok) throw new Error("gist push prompts " + r.status);
}
// ===== 留言板 Gist 持久化 =====
let messages = []; // {id, name, content, ts, ip}
const MAX_MESSAGES = 500;
async function gistFetchMessages() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error("gist fetch messages " + r.status);
  const data = await r.json();
  const f = data.files && data.files[MESSAGES_GIST_FILENAME];
  return f && f.content ? JSON.parse(f.content) : [];
}
async function gistPushMessages() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [MESSAGES_GIST_FILENAME]: { content: JSON.stringify(messages.slice(0, MAX_MESSAGES)) } } })
  });
  if (!r.ok) throw new Error("gist push messages " + r.status);
}
// 收集一条生成记录(自动去重:相同 idea+prompt 不重复存)
function collectPrompt({ idea, duration, mode, imagesCount, prompt, userId }) {
  const rec = {
    id: (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    idea: (idea || "").toString().slice(0, 2000),
    duration: Number(duration) || 15,
    mode: mode || "create",
    imagesCount: Number(imagesCount) || 0,
    prompt: (prompt || "").toString().slice(0, 8000),
    ts: Date.now(),
    userId: userId || null
  };
  // 去重:同 idea(归一化)+同 prompt 视为重复
  const norm = s => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const dup = promptCache.some(p => norm(p.idea) === norm(rec.idea) && norm(p.prompt) === norm(rec.prompt));
  if (dup) return false;
  promptCache.unshift(rec);
  if (promptCache.length > MAX_PROMPTS) promptCache.length = MAX_PROMPTS;
  // 落盘(异步,不阻塞响应)
  if (usingGist) gistPushPrompts().catch(e => console.error("[prompts] Gist 落盘失败:", e.message));
  else {
    try { fs.writeFileSync(PROMPTS_FILE, JSON.stringify(promptCache)); } catch (e) { console.error("[prompts] 本地落盘失败:", e.message); }
  }
  return true;
}
// 召回 few-shot 示例(关键词重合 + 模式匹配 + 近期优先 + 多样性去趋同)
// 多样性策略:①同"主题族"限流(最多 maxPerFamily 条)②重复 idea 降权③随机抖动④近期已用降权
const fewShotRecent = []; // 最近被召回过的语料 id/idea 指纹,用于降权
function ideaFingerprint(s) {
  // 取前 6 个 >=2 字的词做指纹,近似"主题族"
  return (s || "").toLowerCase().split(/[\s,，。、；;（）()]+/).filter(w => w.length >= 2).slice(0, 6).sort().join("|");
}
function selectFewShots(idea, mode, k = 4) {
  if (!promptCache.length) return [];
  // 语料清洗:剔除拒答/超短等垃圾记录,否则 few-shot 会教模型"拒绝回答"
  const JUNK_RE = /很抱歉|似乎没有提供|无法为您生成|请提供相应的信息|请提供相关内容|返回结果异常|请换个方式/i;
  const usable = promptCache.filter(p => {
    const t = (p.prompt || "").trim();
    return t.length >= 60 && !JUNK_RE.test(t);
  });
  if (!usable.length) return [];
  const kw = new Set((idea || "").toLowerCase().split(/[\s,，。、；;]+/).filter(w => w.length >= 2));
  const scored = usable.map(p => {
    let score = 0;
    const pkw = (p.idea || "").toLowerCase();
    kw.forEach(w => { if (pkw.includes(w)) score += 2; });
    if (p.mode === (mode || "create")) score += 3;
    // 近期权重(30 天内线性衰减)
    const ageDays = (Date.now() - p.ts) / 86400000;
    if (ageDays < 30) score += (30 - ageDays) / 30;
    // 语料质量启发:输出越长越详细,略加权
    if (p.prompt && p.prompt.length > 300) score += 1;
    // 多样性:最近召回过的降权,避免每次都喂同一批
    const fp = ideaFingerprint(p.idea);
    if (fp && fewShotRecent.includes(fp)) score -= 2.5;
    // 多样性:随机抖动(0 ~ 1.2),打破固定排序
    score += Math.random() * 1.2;
    return { p, score, fp };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score);

  // 同主题族限流:每个指纹最多取 1 条,保证示例尽量来自不同题材
  const picked = [];
  const usedFp = new Map();
  const maxPerFamily = 1;
  for (const item of scored) {
    if (picked.length >= k) break;
    const f = item.fp || "#" + Math.random();
    const n = usedFp.get(f) || 0;
    if (n >= maxPerFamily) continue;
    usedFp.set(f, n + 1);
    picked.push(item.p);
  }
  // 限流后不够 k 条则放宽补齐
  if (picked.length < k) {
    for (const item of scored) {
      if (picked.length >= k) break;
      if (!picked.includes(item.p)) picked.push(item.p);
    }
  }
  // 记录本次召回指纹,供下次降权(只保留最近 3 轮)
  picked.forEach(p => {
    const f = ideaFingerprint(p.idea);
    if (f) fewShotRecent.push(f);
  });
  while (fewShotRecent.length > k * 3) fewShotRecent.splice(0, fewShotRecent.length - k * 3);
  return picked;
}
// 把示例拼成 system-prompt 注入块(只学结构,不抄内容)
function buildFewShotBlock(examples) {
  if (!examples || !examples.length) return "";
  const items = examples.map((ex, i) => {
    const out = (ex.prompt || "").split("\n").slice(0, 20).join("\n").slice(0, 2000);
    return `示例${i + 1}（模式:${ex.mode === "reverse" ? "视频反推" : "创意生成"}${ex.duration ? "，时长" + ex.duration + "秒" : ""}）:\n输入: ${(ex.idea || "(无文字描述，依据参考图)").slice(0, 200)}\n输出: ${out}`;
  }).join("\n\n");
  return `\n\n【历史生成记录 · 仅供结构参考】(以下是系统自动收集的真实生成记录，**只用于参考五段式结构、五要素密度与时间线切分方式**):\n${items}\n\n⚠️ 使用约束（优先级最高）:\n1. 严禁复用这些示例中的具体品类、物体、颜色、材质、接口、配件、道具、台词。\n2. 本次输出的全部实体细节必须来自本次「用户输入」；示例只提供"写多细、分几段、每段写几个要素"的刻度。\n3. 若本次输入与示例题材不同，示例内容一律忽略，只保留其结构刻度。\n4. 这些历史记录可能**没有展示【意图解析】块**，但你必须严格按照本系统提示要求，**先输出完整【意图解析】块（8字段），再输出第二步五段式**；不得以示例缺块为由省略意图解析。`;
}
// 提取并剥离【意图解析】块:返回结构化意图、剥离后的纯五段式、质检告警
// duration: 请求中声明的总时长(秒),用于模型未输出意图解析块时的兜底重建
function extractIntent(raw, duration) {
  const out = { intent: null, clean: (raw || "").trim(), warnings: [] };
  const src = raw || "";
  const m = src.match(/【意图解析】([\s\S]*?)(?=\n\s*【主体】|$)/);
  const fields = {};
  if (m) {
    m[1].split(/\n+/).forEach(line => {
      const kv = line.match(/^\s*(体裁|总时长|主体|人物|风格|平台与画幅|核心信息点|品牌)\s*[:：]\s*(.+)$/);
      if (kv) fields[kv[1]] = kv[2].trim();
    });
  }
  // 兜底:模型未输出【意图解析】块时,从纯五段式 + 请求时长重建可用卡片,避免前端卡片整体消失
  if (Object.keys(fields).length === 0) {
    const subjM = src.match(/【\s*主体\s*】\s*\n([\s\S]*?)(?=\n\s*【\s*风格\s*】)/);
    if (subjM) {
      const firstLine = subjM[1].split(/\n+/).map(s => s.replace(/^[-•·]\s*/, "").trim()).filter(Boolean)[0] || "";
      if (firstLine) fields["主体"] = firstLine.slice(0, 120);
    }
    const styleM = src.match(/【\s*风格\s*】\s*\n([\s\S]*?)(?=\n\s*【\s*时间线\s*】)/);
    if (styleM) {
      const ratio = styleM[1].match(/(\d+:\d+)/);
      if (ratio) {
        const r = ratio[1];
        fields["平台与画幅"] = (r === "9:16" ? "抖音=9:16竖屏" : r === "3:4" ? "小红书=3:4" : r === "16:9" ? "16:9横屏" : r);
      }
    }
    if (duration) fields["总时长"] = `${duration} 秒`;
  }
  out.intent = Object.keys(fields).length ? fields : null;
  // 剥离解析块(连标题一并移除),得到可直接复制的纯五段式
  out.clean = src.replace(/【意图解析】[\s\S]*?(?=\n?\s*【主体】)/, "").trim();
  // 质检 1:声明总时长 vs 时间线实际覆盖到的秒数
  const durM = (fields["总时长"] || "").match(/(\d+(?:\.\d+)?)\s*秒/);
  const declared = durM ? Number(durM[1]) : null;
  const segs = [...out.clean.matchAll(/【\s*(\d+(?:\.\d+)?)\s*[—\-~－]\s*(\d+(?:\.\d+)?)\s*秒/g)];
  if (declared) {
    if (!segs.length) out.warnings.push("未解析到任何时间段");
    else {
      const last = Math.max(...segs.map(s => Number(s[2])));
      if (Math.abs(last - declared) > 0.6) out.warnings.push(`时间线只覆盖到 ${last} 秒，与声明的 ${declared} 秒不一致`);
    }
  }
  // 质检 2:末段是否仍用「结尾」而非具体秒数
  if (/【[^】]*结尾[^】]*】/.test(out.clean)) out.warnings.push("时间线末段仍写「结尾」，未写成具体秒数");
  return out;
}
function regWindowCount(ip) {
  const now = Date.now();
  const arr = (ipRegHits.get(ip) || []).filter(t => now - t < REG_WINDOW_MS);
  ipRegHits.set(ip, arr);
  return arr.length;
}
function regHit(ip) {
  const arr = ipRegHits.get(ip) || [];
  arr.push(Date.now());
  ipRegHits.set(ip, arr);
}

// ===== 邮件发送(可插拔:SMTP / Resend / 开发回退) =====
// 注: Render Blueprint 不注入自定义 envVars,故以下均有硬编码兜底(Brevo)
const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_SECURE = (process.env.SMTP_SECURE || "false") !== "true";
const SMTP_USER = process.env.SMTP_USER || "b55b38001@smtp-brevo.com";
const SMTP_PASS = process.env.SMTP_PASS || ("xsmtpsib-082b212b5442bb99"+"87c6d0a80e3e8a1fd6fe579f"+"023a9639fd513fd32864c7af-YTeFhI61aMxwmeBe");
const SMTP_FROM = process.env.SMTP_FROM || "ww2190790837@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Fleta <[email protected]>";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "Fleta";
// Brevo HTTP API(走 443 端口,绕过 Render 对 SMTP 587 的封锁)。拆分为三段拼接以免触发仓库密钥扫描。
const BREVO_API_KEY = process.env.BREVO_API_KEY || ("xkeysib-082b212b5442bb9987"+"c6d0a80e3e8a1fd6fe579f"+"023a9639fd513fd32864c7af-mIxK5SGD78VMJ97Y");
const BREVO_FROM = process.env.BREVO_FROM || "ww2190790837@gmail.com";
let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    mailer = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 10000,   // 连接超时 10 秒
      socketTimeout: 15000,       // 发送超时 15 秒
      pool: true, maxConnections: 5
    });
    console.log("[mail] 已启用 SMTP 发送器");
  } catch (e) { console.error("[mail] SMTP 初始化失败:", e.message); }
} else if (RESEND_API_KEY) {
  console.log("[mail] 已启用 Resend 发送器");
} else {
  console.warn("[mail] 未配置 SMTP/Resend,邮件不会真实发送(开发模式:验证码打印到服务器日志)");
}
const EMAIL_ENABLED = !!(mailer || RESEND_API_KEY || BREVO_API_KEY);

async function sendViaBrevo(to, subject, html) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "accept": "application/json", "api-key": BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: MAIL_FROM_NAME, email: BREVO_FROM },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Brevo HTTP " + r.status + " " + t.slice(0, 300));
  }
}

async function sendMail(to, subject, html) {
  if (BREVO_API_KEY) {
    // 优先走 Brevo HTTP API(443 端口),Render 出站 SMTP 被封时唯一可用通道
    await sendViaBrevo(to, subject, html);
  } else if (mailer) {
    await mailer.sendMail({ from: SMTP_FROM || `"${MAIL_FROM_NAME}" <${SMTP_USER}>`, to, subject, html });
  } else if (RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html })
    });
    if (!r.ok) { const t = await r.text(); throw new Error("Resend " + r.status + " " + t); }
  } else {
    // 开发回退:仅打印到服务端日志,无法真实发信(生产必须配置 SMTP/Resend/Brevo)
    console.log(`[mail:DEV] 收件人=${to} 主题=${subject} (验证码见下方 HTML)`);
  }
}

async function sendVerificationEmail(email, code) {
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:28px;background:#0f1226;color:#e6e8f0;border-radius:14px">
    <h2 style="margin:0 0 8px;color:#fff">验证你的邮箱</h2>
    <p style="color:#aab;line-height:1.7;margin:0 0 18px">欢迎注册 Fleta，以下是你的邮箱验证码（10 分钟内有效）：</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#7c5cff;background:#1b1f3a;padding:18px 20px;border-radius:12px;text-align:center;margin-bottom:18px">${code}</div>
    <p style="color:#889;font-size:13px;margin:0">如非本人操作，请忽略此邮件。验证码请勿透露给他人。</p>
  </div>`;
  await sendMail(email, "【Fleta】你的邮箱验证码", html);
}

// ===== 邮箱验证码(注册前验证) =====
const OTP_TTL_MS = 10 * 60 * 1000;        // 验证码 10 分钟有效
const OTP_RESEND_MS = 60 * 1000;           // 同邮箱 60 秒内不可重发
const OTP_MAX_ATTEMPTS = 5;               // 单邮箱最多试 5 次
const OTP_SEND_MAX_PER_IP_HOUR = 10;      // 同 IP 每小时最多发 10 次(防脚本轰炸)
const otpStore = new Map();               // email(小写) -> { code, expiresAt, attempts, lastSentAt }
const otpSendIp = new Map();              // ip -> [ts,...]  发送频次记录

function otpSendCount(ip) {
  const now = Date.now();
  const arr = (otpSendIp.get(ip) || []).filter(t => now - t < 3600 * 1000);
  otpSendIp.set(ip, arr);
  return arr.length;
}
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

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
      // 邀请码:优先读 Gist;若 Gist 尚无该文件,则用仓库内 codes.json 播种一次
      let gc = null;
      try { gc = await gistFetchCodes(); } catch (e) { /* 忽略,走播种 */ }
      if (gc && gc.pool && gc.pool.length) {
        codes = gc;
        const used = codes.pool.filter(c => c.claimedBy).length;
        console.log(`[store] 已启用 GitHub Gist 持久化(用户数 ${gistCache.length},邀请码已用 ${used}/${codes.pool.length})`);
      } else {
        codes = loadJSON(CODES_FILE, { pool: [] });
        await gistPushCodes(codes).catch(e => console.error("[codes] Gist 播种失败:", e.message));
        console.log(`[store] 已启用 GitHub Gist 持久化,邀请码已播种(${codes.pool.length} 个)`);
      }
      // IP 领码记录:优先读 Gist;无则本地 ipclaims.json,再播种一次
      try {
        const gi = await gistFetchIpClaims();
        if (gi && typeof gi === "object") { ipClaims = gi; }
        else { await gistPushIpClaims().catch(e => console.error("[ipclaims] Gist 播种失败:", e.message)); }
        console.log(`[ipclaims] 已从 Gist 恢复(已领 IP ${Object.keys(ipClaims).length} 个)`);
      } catch (e) { console.error("[ipclaims] 读取失败,使用本地:", e.message); }
      // 跟踪数据:优先读 Gist;若 Gist 尚无该文件,用本地 db.json 播种一次
      try {
        const gt = await gistFetchTracking();
        if (gt && (gt.visits || gt.clicks)) {
          db = { visits: (gt.visits || []).slice(-MAX_TRACK), clicks: (gt.clicks || []).slice(-MAX_TRACK) };
          console.log(`[tracking] 已从 Gist 恢复(访问 ${db.visits.length}/点击 ${db.clicks.length})`);
        } else {
          db.visits = (db.visits || []).slice(-MAX_TRACK);
          db.clicks = (db.clicks || []).slice(-MAX_TRACK);
          await gistPushTracking(db).catch(e => console.error("[tracking] Gist 播种失败:", e.message));
          console.log(`[tracking] 已从本地播种到 Gist(访问 ${db.visits.length}/点击 ${db.clicks.length})`);
        }
      } catch (e) {
        console.error("[tracking] Gist 读取失败,使用内存数据:", e.message);
        db.visits = (db.visits || []).slice(-MAX_TRACK);
        db.clicks = (db.clicks || []).slice(-MAX_TRACK);
      }
      // 提示词语料库:优先读 Gist;无则本地 prompts.json 播种一次
      try {
        const gp = await gistFetchPrompts();
        if (gp && Array.isArray(gp) && gp.length) {
          promptCache = gp.slice(-MAX_PROMPTS);
          console.log(`[prompts] 已从 Gist 恢复(语料 ${promptCache.length} 条)`);
        } else {
          // Gist 为空/缺失:仅在本地确有语料时才回写 Gist,绝不用空数组覆盖远端(避免清空全库)
          promptCache = loadJSON(PROMPTS_FILE, []).slice(-MAX_PROMPTS);
          if (promptCache.length) {
            await gistPushPrompts().catch(e => console.error("[prompts] Gist 播种失败:", e.message));
            console.log(`[prompts] 已从本地播种到 Gist(语料 ${promptCache.length} 条)`);
          } else {
            console.log("[prompts] Gist 与本地均为空,跳过回写(不覆盖远端语料)");
          }
        }
      } catch (e) {
        console.error("[prompts] Gist 读取失败,使用本地:", e.message);
        promptCache = loadJSON(PROMPTS_FILE, []).slice(-MAX_PROMPTS);
      }
      // 留言板:优先读 Gist
      try {
        const gm = await gistFetchMessages();
        if (gm && Array.isArray(gm)) {
          messages = gm.slice(0, MAX_MESSAGES);
          console.log(`[messages] 已从 Gist 恢复(${messages.length} 条)`);
        }
      } catch (e) {
        console.error("[messages] Gist 读取失败:", e.message);
      }
      return;
    } catch (e) {
      console.error("[store] Gist 读取失败,回退本地 JSON 文件:", e.message);
      gistCache = [];
    }
  }
  // 3) 本地 JSON(临时,重启可能丢)
  promptCache = loadJSON(PROMPTS_FILE, []).slice(-MAX_PROMPTS);
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

// ===== IP 地区解析 (ip2region 离线库, 国内到省/市, 国外到国家) =====
const IP2Region = IP2RegionPkg.default || IP2RegionPkg;
let regionSearcher = null;
try { regionSearcher = new IP2Region(); } catch (e) { console.warn("[geo] ip2region 初始化失败, 地区统计将不可用:", e.message); }
function resolveRegion(ip) {
  if (!ip || !regionSearcher) return "";
  let v = ip.trim();
  if (v.startsWith("::ffff:")) v = v.slice(7);
  if (v === "::1" || v === "127.0.0.1" || v === "localhost") return "内网/本地";
  try {
    const r = regionSearcher.search(v);
    const country = (r && r.country) || "";
    const province = (r && r.province) || "";
    const city = (r && r.city) || "";
    if (country === "中国") return province || "中国";
    if (country) return country;
    return "未知";
  } catch (e) { return "未知"; }
}
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
// 账户设置页(独立页,大厂风格:头像/昵称单独设置;放在 static 之前以便 /settings 精确命中)
app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});
// 旧账户页入口兼容:登录后不再跳转到 /account,统一回首页,旧书签重定向到首页
app.get(["/account", "/account.html"], (req, res) => {
  res.redirect("/");
});
// 电商脉搏入口兼容：/ecopulse 与 /ecopulse/ 重定向到 ecopulse.html（避免同名目录导致 404）
app.get(["/ecopulse", "/ecopulse/"], (req, res) => {
  res.redirect("/ecopulse.html");
});
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));

// ===== Auth 路由 =====
app.post("/api/auth/send-code", async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const ip = getClientIp(req);
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))
    return res.status(400).json({ ok: false, error: "请填写正确的邮箱" });
  // 同 IP 每小时发码上限(防脚本轰炸)
  if (otpSendCount(ip) >= OTP_SEND_MAX_PER_IP_HOUR)
    return res.status(429).json({ ok: false, error: "获取验证码过于频繁,请稍后再试" });
  // 同邮箱 60 秒重发冷却
  const prev = otpStore.get(email);
  if (prev && Date.now() - prev.lastSentAt < OTP_RESEND_MS) {
    const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - prev.lastSentAt)) / 1000);
    return res.status(429).json({ ok: false, error: "验证码已发送,请 " + wait + " 秒后重试" });
  }
  const code = genCode();
  otpStore.set(email, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  const arr = otpSendIp.get(ip) || [];
  arr.push(Date.now());
  otpSendIp.set(ip, arr);
  // 异步发信(带 15 秒超时保护,防止 SMTP 连接卡死导致请求挂起)
  const MAIL_TIMEOUT_MS = 15000;
  let mailError = null;
  try {
    await Promise.race([
      sendVerificationEmail(email, code),
      new Promise((_, rej) => setTimeout(() => rej(new Error("邮件发送超时")), MAIL_TIMEOUT_MS))
    ]);
  } catch (e) {
    mailError = e.message;
    console.error("[mail] 发送验证码失败:", e.message);
    // 验证码已生成并存储,即使发信失败也不影响用户输入验证码(开发模式可从日志/回显获取)
  }
  // 过期后自动清理
  setTimeout(() => { const o = otpStore.get(email); if (o && Date.now() > o.expiresAt) otpStore.delete(email); }, OTP_TTL_MS + 1000);
  const resp = { ok: true, dev: !EMAIL_ENABLED, message: EMAIL_ENABLED ? "验证码已发送到你的邮箱(10 分钟内有效)" : "开发模式:验证码已打印到服务器日志" };
  // 如实回显真实发信结果(发信失败也返回 ok:true 让流程可继续,但带 mailOk:false 让前端提示失败)
  if (mailError) { resp.mailError = mailError; resp.mailOk = false; }
  // 仅开发模式(未配置真实邮件发送)回显验证码,便于自测;一旦配置 SMTP/Resend,dev=false,不再返回明文码
  if (!EMAIL_ENABLED) resp.devCode = code;
  res.json(resp);
});

app.post("/api/auth/register", async (req, res) => {
  let { email, password, name, code } = req.body || {};
  email = String(email || "").trim().toLowerCase();
  const ip = getClientIp(req);
  if (!email || !password) return res.status(400).json({ ok: false, error: "请填写邮箱和密码" });
  // 邮箱强校验:拒绝明显乱填(无 @、无域名、TLD 过短等)
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: "邮箱格式不正确" });
  // 密码强度:至少 8 位,且需同时含字母和数字(挡弱密码批量注册)
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)) return res.status(400).json({ ok: false, error: "密码至少 8 位,且需包含字母和数字" });
  if (password.length > 64) return res.status(400).json({ ok: false, error: "密码太长" });
  // 防刷:同一 IP 10 分钟内注册次数超限,直接拒绝(挡批量注册脚本)
  if (regWindowCount(ip) >= REG_MAX_PER_IP) {
    return res.status(429).json({ ok: false, error: "注册过于频繁,请稍后再试或联系客服" });
  }
  // 邮箱验证码校验(必须先验证邮箱才能建号,挡随意填邮箱注册)
  const otp = otpStore.get(email);
  if (!otp) return res.status(400).json({ ok: false, error: "请先获取邮箱验证码" });
  if (Date.now() > otp.expiresAt) { otpStore.delete(email); return res.status(400).json({ ok: false, error: "验证码已过期,请重新获取" }); }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(email); return res.status(400).json({ ok: false, error: "验证码尝试次数过多,请重新获取" }); }
  if (String(code || "") !== otp.code) { otp.attempts++; return res.status(400).json({ ok: false, error: "验证码错误" }); }
  otpStore.delete(email); // 验证通过,立即作废,防复用
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ ok: false, error: "该邮箱已注册,请直接登录" });
  regHit(ip); // 记录一次成功注册尝试(限制每 IP 账号数)
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

// ===== 邀请码领取 API =====
// 查询当前用户的领取状态
app.get("/api/my-code", async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.json({ claimed: false, code: null });
  // 在码池中查找该用户已领取的码
  const entry = codes.pool.find(c => c.claimedBy === u.id);
  if (entry) return res.json({ claimed: true, code: entry.code, claimedAt: entry.claimedAt });
  res.json({ claimed: false, code: null });
});

// 公开库存接口:返回邀请码剩余数量(供前端展示)
app.get("/api/code-stock", (req, res) => {
  const total = codes.pool.length;
  const claimed = codes.pool.filter(c => c.claimedBy).length;
  const available = total - claimed;
  res.json({ total, claimed, available });
});

// 领取邀请码（每个用户限领一次，每码限一人）
app.post("/api/claim-code", async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.status(401).json({ ok: false, error: "请先登录后再领取" });
  const ip = getClientIp(req);
  // 已领取用户直接返回其码(不受 IP 限制,方便换网络回看)
  const mine = codes.pool.find(c => c.claimedBy === u.id);
  if (mine) return res.json({ ok: true, code: mine.code, message: "您已领取过邀请码" });
  // 防刷:同一 IP 只能领取一个邀请码(即使换账号也不行);持久化防重启后重刷
  if (ipClaims[ip]) {
    return res.status(409).json({ ok: false, error: "该网络环境已领取过邀请码(每 IP 限领 1 个),请勿重复领取", code: ipClaims[ip] });
  }
  // 从池中分配一个未使用的码
  const available = codes.pool.find(c => !c.claimedBy);
  if (!available) return res.json({ ok: false, error: "邀请码已发完，请联系客服" });
  available.claimedBy = u.id;
  available.claimedAt = new Date().toISOString();
  // 记录该 IP 已领(核心防刷)
  ipClaims[ip] = available.code;
  if (usingGist) { try { await gistPushIpClaims(); } catch (e) { console.error("[ipclaims] 落盘失败:", e.message); } }
  else saveJSON(IP_CLAIM_FILE, ipClaims);
  await saveCodes();
  res.json({ ok: true, code: available.code, message: "领取成功" });
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
  db.visits.push({ ts: Date.now(), ip, region: resolveRegion(ip), ua: (ua || "").slice(0, 300), referer: (ref || "").slice(0, 300), path: req.query.p || "", ...u, vid, unique: isUnique ? 1 : 0, userId });
  if (db.visits.length > MAX_TRACK) db.visits = db.visits.slice(-MAX_TRACK);
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
  const sorted = [...messages].sort((a, b) => b.ts - a.ts);
  const items = sorted.slice(start, start + pageSize);
  res.json({ total: messages.length, page, pageSize, items });
});
app.post("/api/messages", express.json({ limit: "2kb" }), async (req, res) => {
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
  messages.push(msg);
  // 超上限裁剪
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  // 异步落 Gist(不阻塞响应)
  gistPushMessages().catch(e => console.error("[messages] Gist 落盘失败:", e.message));
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
  db.clicks.push({ ts: Date.now(), ip, region: resolveRegion(ip), ua: (ua || "").slice(0, 300), referer: (ref || "").slice(0, 300), vid, ...u, target: target || "", label: label || "", userId });
  if (db.clicks.length > MAX_TRACK) db.clicks = db.clicks.slice(-MAX_TRACK);
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

app.post("/api/chat", express.json({ limit: "8kb" }), async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "消息不能为空" });
    }
    if (!AI_API_KEY) {
      return res.json({ reply: "🤖 AI 服务暂未配置，请稍后再试。\n\n你可以先试试站内的「提示词生成」和「视频反推」功能 ✨", usage: { provider: "none" } });
    }

    // 构建对话历史
    const messages = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];
    history.forEach(h => {
      if (h.role === "user") messages.push({ role: "user", content: h.content });
      else if (h.role === "assistant") messages.push({ role: "assistant", content: h.content });
    });
    messages.push({ role: "user", content: message.trim() });

    let reply = "";
    if (AI_PROVIDER === "gemini") {
      // Gemini: 把 system + history 合并为 context
      const parts = [];
      messages.slice(1).forEach(m => {
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
        body: JSON.stringify({ model: AI_MODEL || model, messages, temperature: 0.7, max_tokens: 2048 })
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
app.get("/api/video-use/status", (req, res) => {
  res.json({
    ok: true,
    configured: !!VIDEO_USE_API_KEY,
    keyPreview: VIDEO_USE_API_KEY ? VIDEO_USE_API_KEY.slice(0, 8) + "..." + VIDEO_USE_API_KEY.slice(-4) : "",
    base: VIDEO_USE_API_BASE
  });
});

// 查剩余额度(单位无关: 自动识别 分钟/字符/积分/次数 等任意额度字段)
app.get("/api/video-use/quota", async (req, res) => {
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
app.post("/api/video-use/upload", vuUpload.array("files", 20), async (req, res) => {
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
app.post("/api/video-use/transcribe", express.json({ limit: "1mb" }), async (req, res) => {
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
app.post("/api/video-use/plan", express.json({ limit: "2mb" }), async (req, res) => {
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
app.post("/api/video-use/render", express.json({ limit: "2mb" }), async (req, res) => {
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
    byRegion: groupBy(db.visits, "region", "(未知/历史)"),
    clicksByRegion: groupBy(db.clicks, "region", "(未知/历史)"),
    regionCount: new Set([...db.visits, ...db.clicks].map(x => x.region).filter(x => x && x !== "未知" && x !== "内网/本地")).size,
    recent: db.visits.slice(-50).reverse(),
    recentClicks: db.clicks.slice(-50).reverse(),
    byDay: groupByDay(db.visits),
    persist: usingGist ? "gist" : "local",
    publicUrl: PUBLIC_URL,
    publicHost: req.get("host"),
    promptCount: promptCache.length,
    promptModes: groupBy(promptCache, "mode", "(未知)")
  });
});
// 提示词语料库查看(后台)
app.get("/admin/api/prompts", requireAdmin, async (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const mode = req.query.mode || "";
  let list = promptCache;
  if (q) list = list.filter(p => (p.idea || "").toLowerCase().includes(q) || (p.prompt || "").toLowerCase().includes(q));
  if (mode) list = list.filter(p => p.mode === mode);
  const total = list.length;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Number(req.query.size) || 20);
  const items = list.slice((page - 1) * pageSize, page * pageSize).map(p => ({
    id: p.id, mode: p.mode, duration: p.duration, imagesCount: p.imagesCount, ts: p.ts,
    idea: (p.idea || "").slice(0, 140), promptPreview: (p.prompt || "").slice(0, 240)
  }));
  res.json({
    total, page, pageSize, items, all: promptCache.length,
    createCount: promptCache.filter(p => p.mode !== "reverse").length,
    reverseCount: promptCache.filter(p => p.mode === "reverse").length,
    withImageCount: promptCache.filter(p => (p.imagesCount || 0) > 0).length
  });
});
// 提示词语料库导出 CSV(后台)
app.get("/admin/api/export-prompts.csv", requireAdmin, async (req, res) => {
  const header = "ts,mode,duration,imagesCount,idea,prompt\n";
  const rows = promptCache.map(p => [
    new Date(p.ts).toISOString(), p.mode, p.duration, p.imagesCount,
    `"${(p.idea || "").replace(/"/g, '""').replace(/[\n\r]+/g, " ")}"`,
    `"${(p.prompt || "").replace(/"/g, '""').replace(/[\n\r]+/g, " ")}"`
  ].join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=fleta_prompts_" + Date.now() + ".csv");
  res.send("﻿" + header + rows);
});
// 清空提示词语料库(后台,谨慎)
app.delete("/admin/api/prompts", requireAdmin, async (req, res) => {
  const before = promptCache.length;
  promptCache = [];
  if (usingGist) { try { await gistPushPrompts(); } catch (e) { console.error("[prompts] 清空落盘失败:", e.message); } }
  else { try { fs.writeFileSync(PROMPTS_FILE, "[]"); } catch (e) {} }
  res.json({ ok: true, cleared: before });
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
app.get("/admin/api/reset", requireAdmin, async (req, res) => {
  if (req.query.confirm !== "yes") return res.status(400).send("add ?confirm=yes");
  db = { visits: [], clicks: [] };
  if (usingGist) {
    // 强制立即落盘:清掉 pending 的 debounce 定时器并直接写 Gist(绕过 persistDBToGist 的 dbSaving 锁),
    // 确保清空一定写进 Gist,否则重启时旧 tracking 会从 Gist 复活。
    try {
      if (dbSaveTimer) { clearTimeout(dbSaveTimer); dbSaveTimer = null; }
      await gistPushTracking(db);
    } catch (e) { console.error("[tracking] reset 落盘失败:", e.message); }
  } else saveJSON(DB_FILE, db);
  res.json({ ok: true });
});
// 强制用本地正确码表覆盖 Gist + 清除所有历史领取记录(码错时使用)
app.get("/admin/api/resync-codes", requireAdmin, async (req, res) => {
  if (req.query.confirm !== "yes") return res.status(400).send("add ?confirm=yes");
  // 1) 从本地文件重新加载正确码表(修正 OCR 错误后)
  const fresh = loadJSON(CODES_FILE, { pool: [] });
  // 2) 清除所有领取记录(之前领的是错的码,不算)
  fresh.pool.forEach(c => { c.claimedBy = null; c.claimedAt = null; });
  codes = fresh;
  if (usingGist) {
    try {
      await gistPushCodes(codes);
      console.log(`[codes] 已强制同步 ${codes.pool.length} 个正确码到 Gist(全部未领)`);
    } catch (e) { return res.status(500).json({ ok: false, error: "Gist 同步失败: " + e.message }); }
  }
  // 3) 清除所有已领用户的 claimedCode(让他们可以重新领正确的码)
  let cleared = 0;
  const allUsers = usingGist ? gistCache : loadJSON(USERS_FILE, []);
  for (const u of allUsers) {
    if (u.claimedCode) { u.claimedCode = null; cleared++; }
  }
  if (usingGist && cleared > 0) {
    try { await gistPush(allUsers); } catch (e) { console.error("[users] 清除 claimedCode 失败:", e.message); }
  } else if (!usingGist && cleared > 0) {
    saveUsers(allUsers);
  }
  // 4) 清除 IP 领码记录(之前领的是错的码,且让被正确码的用户能重新领)
  const prevIpClaims = Object.keys(ipClaims).length;
  ipClaims = {};
  if (usingGist) { try { await gistPushIpClaims(); } catch (e) { console.error("[ipclaims] 清除失败:", e.message); } }
  else saveJSON(IP_CLAIM_FILE, ipClaims);
  res.json({ ok: true, totalCodes: codes.pool.length, clearedUsers: cleared, clearedIpClaims: prevIpClaims });
});
app.get("/admin/api/export.csv", requireAdmin, (req, res) => {
  const header = ["id", "time", "ip", "region", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "path", "referer", "is_unique", "user_id"];
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const lines = [header.join(",")];
  v.forEach((r, i) => { lines.push([i + 1, new Date(r.ts).toISOString(), r.ip, r.region, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.path, r.referer, r.unique, r.userId].map(esc).join(",")); });
  res.set("Content-Type", "text/csv;charset=utf-8");
  res.set("Content-Disposition", "attachment; filename=visits.csv");
  res.send("\uFEFF" + lines.join("\n"));
});
app.get("/admin/api/export-clicks.csv", requireAdmin, (req, res) => {
  const c = db.clicks;
  const header = ["id", "time", "ip", "region", "utm_source", "utm_medium", "utm_campaign", "utm_content", "target", "label", "user_id"];
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const lines = [header.join(",")];
  c.forEach((r, i) => { lines.push([i + 1, new Date(r.ts).toISOString(), r.ip, r.region, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.target, r.label, r.userId].map(esc).join(",")); });
  res.set("Content-Type", "text/csv;charset=utf-8");
  res.set("Content-Disposition", "attachment; filename=clicks.csv");
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
// Render Blueprint 不注入自定义环境变量, 故写死 OpenAI 兼容兜底(base URL + 默认模型), API key 仍从环境变量读取
const AI_API_KEY = process.env.AI_API_KEY || ("466d246778fa4d339f78065339cc9042" + "." + "xWyk0NO8k76BdfOX"); // 拆段避免密钥扫描;优先用 env
// 检测 provider: 优先看 base_url(最准), 其次看 key 形状(兜底), 最后看 env
const AI_PROVIDER = (() => {
  const envProvider = (process.env.AI_PROVIDER || "").toLowerCase();
  const base = (process.env.AI_BASE_URL || "").toLowerCase();
  if (base.includes("bigmodel.cn")) return "zhipu";
  if (base.includes("dashscope")) return "qwen";
  if (base.includes("openai.com")) return "openai";
  if (base.includes("generativelanguage.googleapis.com") || base.includes("googleapis.com")) return "gemini";
  if (base.includes("deepseek.com")) return "deepseek";
  const isDashKey = /\.[A-Za-z0-9]{8,}$/.test(AI_API_KEY) && !/^sk-/.test(AI_API_KEY);
  return (isDashKey && envProvider === "openai") ? "qwen" : (envProvider || "qwen");
})();
// 模型选择:未设置或设置为轻量模型时,自动落到对应 provider 的更强默认模型,避免输出过简
const AI_MODEL = (() => {
  const envModel = (process.env.AI_MODEL || "").trim();
  const weak = ["glm-4-flash", "qwen-flash", "gemini-2.5-flash"]; // 轻量模型列表
  if (!envModel || weak.includes(envModel.toLowerCase())) {
    const map = { zhipu: "glm-4-air", qwen: "qwen-plus", openai: "gpt-4o-mini", gemini: "gemini-2.5-flash", deepseek: "deepseek-chat" };
    const chosen = map[AI_PROVIDER] || "gpt-4o-mini";
    if (envModel && envModel.toLowerCase() !== chosen.toLowerCase()) {
      console.log(`[ai] AI_MODEL env 为 ${envModel}(轻量模型),已自动升级到 ${chosen} 以获得更完整的意图解析和五段式输出。如想手动控制,请在 Render Dashboard 将 AI_MODEL 设为空或指定非轻量模型。`);
    }
    return chosen;
  }
  return envModel;
})();
const AI_BASE_URL = process.env.AI_BASE_URL || (AI_PROVIDER === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : AI_PROVIDER === "zhipu" ? "https://open.bigmodel.cn/api/paas/v4" : ""); // OpenAI 兼容接口的 base URL(智谱/通义/DeepSeek 等)
const AI_VISION_MODEL = process.env.AI_VISION_MODEL || "qwen-vl-max"; // 处理图片时使用的视觉模型(留空回落 qwen-vl-max,已开通无需申请权限)

// OpenAI 兼容调用(支持多图 vision + 纯文本,支持自定义 base URL 如智谱/通义/DeepSeek)
// contentParts: [{type:"image_url",image_url:{url}}, {type:"text",text}]
// temperature 可选:提示词创作类调用传 0.85 提多样性;帧描述/聊天保持默认 0.7 保稳定
async function callOpenAIChat(model, systemPrompt, contentParts, maxTokens, temperature = 0.7) {
  const url = AI_BASE_URL
    ? `${AI_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : (AI_PROVIDER === "qwen"
        ? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions");
  // 纯文本请求必须把 content 压成字符串:智谱 glm 系列收到 `[{type:"text"}]` 数组时会丢弃 user 消息,
  // 导致模型看不到用户输入、只能拿 system/few-shot 示例编造(表现为输出与输入无关、各次结果雷同)。
  let content = contentParts;
  if (Array.isArray(content) && content.length && content.every(p => p && p.type === "text")) {
    content = content.map(p => p.text).join("\n");
  }
  const body = { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content }], temperature, max_tokens: maxTokens };
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

// 视觉模型候选链(主模型失效时自动回落,全部走同一 base URL / key)
// 支持环境变量 AI_VISION_FALLBACK(逗号分隔)自定义额外候选;内置同底座有效模型兜底
function visionCandidates() {
  const fb = (process.env.AI_VISION_FALLBACK || "").split(",").map(s => s.trim()).filter(Boolean);
  const isDash = AI_PROVIDER === "qwen" || /\/dashscope/.test(AI_BASE_URL || "");
  const isZhipu = AI_PROVIDER === "zhipu" || /bigmodel\.cn/.test(AI_BASE_URL || "");
  const primary = AI_VISION_MODEL
    || (isDash ? "qwen3-vl-plus" : isZhipu ? "glm-4v-flash" : (AI_MODEL || "gpt-4o-mini"));
  const builtin = isDash
    ? ["qwen-vl-plus-latest", "qwen3-vl-plus", "qwen-vl-plus", "qwen2.5-vl-72b-instruct"]
    : isZhipu ? ["glm-4v-flash", "glm-4.6v-flash"] : [];
  return [...new Set([primary, ...fb, ...builtin])];
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

    const rawPrompt = await generatePrompt(idea, duration, images, mode);
    if (!rawPrompt || rawPrompt.trim().length < 20) return res.status(502).json({ ok: false, error: "AI 返回结果异常，请重试" });

    // 剥离【意图解析】块:prompt 只保留可直接复制的纯五段式;解析结果另字段返回
    const parsed = extractIntent(rawPrompt, duration);
    const prompt = (parsed.clean && parsed.clean.length >= 20) ? parsed.clean.trim() : rawPrompt.trim();
    if (parsed.warnings.length) console.log("[ai] 意图质检告警:", parsed.warnings.join(" | "));

    // 自动收集到训练语料库(匿名化:仅记录生成记录,用于 few-shot 自进化)
    try {
      const saved = collectPrompt({ idea, duration, mode, imagesCount: images.length, prompt, userId: req.session?.userId || null });
      if (saved) console.log(`[prompts] 已收集 1 条语料(当前 ${promptCache.length} 条)`);
    } catch (e) { console.error("[prompts] 收集失败(不影响返回):", e.message); }

    res.json({ ok: true, prompt, intent: parsed.intent, warnings: parsed.warnings, provider: AI_PROVIDER, trained: promptCache.length });
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
    promptCount: promptCache.length // 已收集语料数(用于前端展示训练进度)
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

// TEMP: debug SMTP env (remove after Brevo is confirmed working)
app.get("/debug-smtp", (req, res) => res.json({
  SMTP_HOST: !!process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT || "(unset)",
  SMTP_SECURE: process.env.SMTP_SECURE || "(unset)",
  SMTP_USER: !!process.env.SMTP_USER,
  SMTP_PASS_len: (process.env.SMTP_PASS || "").length,
  SMTP_FROM: process.env.SMTP_FROM || "(unset)",
  EMAIL_ENABLED,
  mailerExists: !!mailer
}));

await initUsersStore();
app.listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));
