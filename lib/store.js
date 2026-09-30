import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import mongoose from "mongoose";
import crypto from "node:crypto";
import fs from "node:fs";
import IP2RegionPkg from "ip2region";
import {
  DB_FILE, CODES_FILE, IP_CLAIM_FILE, PROMPTS_FILE, USERS_FILE, MONGODB_URI,
  GIST_TOKEN, GIST_ID, GIST_FILENAME, CODES_GIST_FILENAME, TRACKING_GIST_FILENAME,
  IP_CLAIM_GIST_FILENAME, PROMPTS_GIST_FILENAME, MESSAGES_GIST_FILENAME,
  MAX_TRACK, MAX_PROMPTS, MAX_MESSAGES, REG_WINDOW_MS, REG_MAX_PER_IP,
  OTP_TTL_MS, OTP_RESEND_MS, OTP_MAX_ATTEMPTS, OTP_SEND_MAX_PER_IP_HOUR
} from "./config.js";

export function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
export function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// 加载现有 visits/clicks DB(本地仅作兜底/首次播种;联网优先走 Gist)
let db = loadJSON(DB_FILE, { visits: [], clicks: [] });
let codes = loadJSON(CODES_FILE, { pool: [] });

// ---- 跟踪数据持久化:优先 Gist(异步 debounce,避免每次请求都打 API 触发限流)+ 本地兜底 ----
let dbSaveTimer = null;
let dbSaving = false;
export function saveDB(immediate) {
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
export async function persistDBToGist() {
  if (dbSaving) return; // 上一次未完成,下个周期再写
  dbSaving = true;
  try { await gistWrite(TRACKING_GIST_FILENAME, db); }
  catch (e) { console.error("[tracking] Gist 持久化失败(内存保留,稍后重试):", e.message); }
  finally { dbSaving = false; }
}
// 进程退出(SIGTERM/SIGINT)前尽量落盘,压缩重启丢数据窗口
export async function flushDB() {
  if (usingGist) { try { await gistWrite(TRACKING_GIST_FILENAME, db); } catch (e) { console.error("[tracking] 退出落盘失败:", e.message); } }
}
process.on("SIGTERM", () => { flushDB().finally(() => process.exit(0)); });
process.on("SIGINT", () => { flushDB().finally(() => process.exit(0)); });
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", (reason && reason.stack) || reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", (err && err.stack) || err));
export function saveCodes() {
  if (usingGist) {
    return gistWrite(CODES_GIST_FILENAME, codes, true).catch(e => console.error("[codes] Gist 持久化失败,回退本地:", e.message));
  }
  saveJSON(CODES_FILE, codes);
}

// users(仅 JSON 回退使用 saveUsers;其余读写走下方 MongoDB 存储层)
export function saveUsers(u) { saveJSON(USERS_FILE, u); }
export function publicUser(u) { return { id: u.id, email: u.email, name: u.name, plan: u.plan, role: u.role, avatar: u.avatar || null, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, loginCount: u.loginCount }; }

// ============================================================
//  用户存储层:优先 MongoDB(联网持久化),否则回退本地 JSON 文件
// ============================================================
let usingMongo = false;
let UserModel = null;

// ===== Video-Use 辅助 API (ElevenLabs Scribe 转写/处理) =====
// 实测确认: sk_ 前缀为 ElevenLabs 新版 key 格式; apisk_ 前缀非 ElevenLabs key(返回 Invalid API key)。
// Render Blueprint 不注入自定义环境变量, 故地址/key 写死在此, 更换服务改这里即可。
// 跟踪记录容量上限(兼顾 Gist 单文件 ~1MB 限制 + 分析需求)
let usingGist = false;
let gistCache = [];

// ===== GitHub Gist 客户端(统一读写,替代原先 12 个 fetch/push 重复函数) =====
const GIST_BASE = "https://api.github.com/gists";
export function gistHeaders(patch = false) {
  const h = { Authorization: `Bearer ${GIST_TOKEN}`, "User-Agent": "fleta-ai", Accept: "application/vnd.github+json" };
  if (patch) h["Content-Type"] = "application/json";
  return h;
}
export async function gistRead(filename, fallback = null) {
  if (!GIST_ID || !GIST_TOKEN) return fallback;
  const r = await fetch(`${GIST_BASE}/${GIST_ID}`, { headers: gistHeaders() });
  if (!r.ok) throw new Error(`gist fetch ${filename} ${r.status}`);
  const data = await r.json();
  const f = data.files && data.files[filename];
  return f && typeof f.content === "string" ? JSON.parse(f.content) : fallback;
}
export async function gistWrite(filename, data, pretty = false) {
  if (!GIST_ID || !GIST_TOKEN) return;
  const content = JSON.stringify(data, pretty ? null : undefined, pretty ? 2 : 0);
  const r = await fetch(`${GIST_BASE}/${GIST_ID}`, {
    method: "PATCH",
    headers: gistHeaders(true),
    body: JSON.stringify({ files: { [filename]: { content } } })
  });
  if (!r.ok) throw new Error(`gist push ${filename} ${r.status}`);
}


// 邀请码同样走 Gist(单独文件,与 users 同一 Gist,互不影响)


// 访问/点击跟踪数据同样走 Gist(单独文件,与 users/codes 同一 Gist)
// 用紧凑 JSON(无缩进)以压低体积,避免超过 Gist 单文件 ~1MB 上限



// ===== 注册 / 领码 防刷限流层 (build-your-own-x: 限流器 Rate Limiter) =====
// 目标:防止脚本批量注册 + 刷光邀请码。
// 1) IP 注册限流:滑动窗口,每 IP 10 分钟内最多注册 N 次(挡批量注册脚本;内存即可,重启清零可接受)
const ipRegHits = new Map(); // ip -> [ts, ts, ...]
// 2) IP 领码上限:同一 IP 只能成功领取 1 个邀请码(即使换账号也不行);持久化防重启后重复刷
let ipClaims = loadJSON(IP_CLAIM_FILE, {}); // { ip: code }



// 3) 提示词训练语料库(独立文件):自动收集用户生成记录,用于 few-shot 自进化
let promptCache = []; // [{id, idea, duration, mode, imagesCount, prompt, ts, userId?}]


// ===== 留言板 Gist 持久化 =====
let messages = []; // {id, name, content, ts, ip}


// 收集一条生成记录(自动去重:相同 idea+prompt 不重复存)
export function collectPrompt({ idea, duration, mode, imagesCount, prompt, userId }) {
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
  if (usingGist) gistWrite(PROMPTS_GIST_FILENAME, promptCache).catch(e => console.error("[prompts] Gist 落盘失败:", e.message));
  else {
    try { fs.writeFileSync(PROMPTS_FILE, JSON.stringify(promptCache)); } catch (e) { console.error("[prompts] 本地落盘失败:", e.message); }
  }
  return true;
}
// 召回 few-shot 示例(关键词重合 + 模式匹配 + 近期优先 + 多样性去趋同)
// 多样性策略:①同"主题族"限流(最多 maxPerFamily 条)②重复 idea 降权③随机抖动④近期已用降权
const fewShotRecent = []; // 最近被召回过的语料 id/idea 指纹,用于降权
export function ideaFingerprint(s) {
  // 取前 6 个 >=2 字的词做指纹,近似"主题族"
  return (s || "").toLowerCase().split(/[\s,，。、；;（）()]+/).filter(w => w.length >= 2).slice(0, 6).sort().join("|");
}
export function selectFewShots(idea, mode, k = 4) {
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
export function buildFewShotBlock(examples) {
  if (!examples || !examples.length) return "";
  const items = examples.map((ex, i) => {
    const out = (ex.prompt || "").split("\n").slice(0, 20).join("\n").slice(0, 2000);
    return `示例${i + 1}（模式:${ex.mode === "reverse" ? "视频反推" : "创意生成"}${ex.duration ? "，时长" + ex.duration + "秒" : ""}）:\n输入: ${(ex.idea || "(无文字描述，依据参考图)").slice(0, 200)}\n输出: ${out}`;
  }).join("\n\n");
  return `\n\n【历史生成记录 · 仅供结构参考】(以下是系统自动收集的真实生成记录，**只用于参考五段式结构、五要素密度与时间线切分方式**):\n${items}\n\n⚠️ 使用约束（优先级最高）:\n1. 严禁复用这些示例中的具体品类、物体、颜色、材质、接口、配件、道具、台词。\n2. 本次输出的全部实体细节必须来自本次「用户输入」；示例只提供"写多细、分几段、每段写几个要素"的刻度。\n3. 若本次输入与示例题材不同，示例内容一律忽略，只保留其结构刻度。\n4. 这些历史记录可能**没有展示【意图解析】块**，但你必须严格按照本系统提示要求，**先输出完整【意图解析】块（8字段），再输出第二步五段式**；不得以示例缺块为由省略意图解析。`;
}
// 提取并剥离【意图解析】块:返回结构化意图、剥离后的纯五段式、质检告警
// duration: 请求中声明的总时长(秒),用于模型未输出意图解析块时的兜底重建
export function extractIntent(raw, duration) {
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
export function regWindowCount(ip) {
  const now = Date.now();
  const arr = (ipRegHits.get(ip) || []).filter(t => now - t < REG_WINDOW_MS);
  ipRegHits.set(ip, arr);
  return arr.length;
}
export function regHit(ip) {
  const arr = ipRegHits.get(ip) || [];
  arr.push(Date.now());
  ipRegHits.set(ip, arr);
}

// ===== 邮箱验证码(注册前验证) =====
const otpStore = new Map();               // email(小写) -> { code, expiresAt, attempts, lastSentAt }
const otpSendIp = new Map();              // ip -> [ts,...]  发送频次记录

export function otpSendCount(ip) {
  const now = Date.now();
  const arr = (otpSendIp.get(ip) || []).filter(t => now - t < 3600 * 1000);
  otpSendIp.set(ip, arr);
  return arr.length;
}
export function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

export async function initUsersStore() {
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
      gistCache = await gistRead(GIST_FILENAME, []);
      usingGist = true;
      // 邀请码:优先读 Gist;若 Gist 尚无该文件,则用仓库内 codes.json 播种一次
      let gc = null;
      try { gc = await gistRead(CODES_GIST_FILENAME); } catch (e) { /* 忽略,走播种 */ }
      if (gc && gc.pool && gc.pool.length) {
        codes = gc;
        const used = codes.pool.filter(c => c.claimedBy).length;
        console.log(`[store] 已启用 GitHub Gist 持久化(用户数 ${gistCache.length},邀请码已用 ${used}/${codes.pool.length})`);
      } else {
        codes = loadJSON(CODES_FILE, { pool: [] });
        await gistWrite(CODES_GIST_FILENAME, codes, true).catch(e => console.error("[codes] Gist 播种失败:", e.message));
        console.log(`[store] 已启用 GitHub Gist 持久化,邀请码已播种(${codes.pool.length} 个)`);
      }
      // IP 领码记录:优先读 Gist;无则本地 ipclaims.json,再播种一次
      try {
        const gi = await gistRead(IP_CLAIM_GIST_FILENAME);
        if (gi && typeof gi === "object") { ipClaims = gi; }
        else { await gistWrite(IP_CLAIM_GIST_FILENAME, ipClaims).catch(e => console.error("[ipclaims] Gist 播种失败:", e.message)); }
        console.log(`[ipclaims] 已从 Gist 恢复(已领 IP ${Object.keys(ipClaims).length} 个)`);
      } catch (e) { console.error("[ipclaims] 读取失败,使用本地:", e.message); }
      // 跟踪数据:优先读 Gist;若 Gist 尚无该文件,用本地 db.json 播种一次
      try {
        const gt = await gistRead(TRACKING_GIST_FILENAME);
        if (gt && (gt.visits || gt.clicks)) {
          db = { visits: (gt.visits || []).slice(-MAX_TRACK), clicks: (gt.clicks || []).slice(-MAX_TRACK) };
          console.log(`[tracking] 已从 Gist 恢复(访问 ${db.visits.length}/点击 ${db.clicks.length})`);
        } else {
          db.visits = (db.visits || []).slice(-MAX_TRACK);
          db.clicks = (db.clicks || []).slice(-MAX_TRACK);
          await gistWrite(TRACKING_GIST_FILENAME, db).catch(e => console.error("[tracking] Gist 播种失败:", e.message));
          console.log(`[tracking] 已从本地播种到 Gist(访问 ${db.visits.length}/点击 ${db.clicks.length})`);
        }
      } catch (e) {
        console.error("[tracking] Gist 读取失败,使用内存数据:", e.message);
        db.visits = (db.visits || []).slice(-MAX_TRACK);
        db.clicks = (db.clicks || []).slice(-MAX_TRACK);
      }
      // 提示词语料库:优先读 Gist;无则本地 prompts.json 播种一次
      try {
        const gp = await gistRead(PROMPTS_GIST_FILENAME);
        if (gp && Array.isArray(gp) && gp.length) {
          promptCache = gp.slice(-MAX_PROMPTS);
          console.log(`[prompts] 已从 Gist 恢复(语料 ${promptCache.length} 条)`);
        } else {
          // Gist 为空/缺失:仅在本地确有语料时才回写 Gist,绝不用空数组覆盖远端(避免清空全库)
          promptCache = loadJSON(PROMPTS_FILE, []).slice(-MAX_PROMPTS);
          if (promptCache.length) {
            await gistWrite(PROMPTS_GIST_FILENAME, promptCache).catch(e => console.error("[prompts] Gist 播种失败:", e.message));
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
        const gm = await gistRead(MESSAGES_GIST_FILENAME, []);
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
export function validateAvatar(dataUrl) {
  const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[3], "base64"); // m[3] 才是 base64 数据
  if (!buf || buf.length > 2 * 1024 * 1024) return null; // 解码后上限 2MB
  return dataUrl;
}

export async function loadUsers() {
  if (usingMongo) return UserModel.find({}).lean();
  if (usingGist) return gistCache;
  return loadJSON(USERS_FILE, []);
}
export async function findUserByEmail(email) {
  if (usingMongo) return UserModel.findOne({ email: String(email).toLowerCase() }).lean();
  return (await loadUsers()).find(u => u.email.toLowerCase() === String(email).toLowerCase());
}
export async function findUserById(id) {
  if (usingMongo) return UserModel.findOne({ id }).lean();
  return (await loadUsers()).find(u => u.id === id);
}

// 登录态校验中间件: 未登录的功能型接口一律返回 401(前端门禁只是 UX, 这里才是真边界)
export function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ ok: false, error: "请先登录后再使用", code: "auth_required" });
}
export async function createUser({ email, password, name }) {
  const id = nanoid(12);
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const user = {
    id, email: email.toLowerCase(), name: name || email.split("@")[0],
    passwordHash, plan: "trial", role: "user", avatar: null,
    createdAt: now, lastLoginAt: now, loginCount: 1
  };
  if (usingMongo) await UserModel.create(user);
  else if (usingGist) { gistCache.push(user); await gistWrite(GIST_FILENAME, gistCache, true).catch(e => console.error("[store] gist push 失败:", e.message)); }
  else { const users = await loadUsers(); users.push(user); saveUsers(users); }
  return user;
}
export async function updateUser(u) {
  if (usingMongo) await UserModel.updateOne({ id: u.id }, u, { upsert: false });
  else if (usingGist) {
    const idx = gistCache.findIndex(x => x.id === u.id);
    if (idx >= 0) { gistCache[idx] = u; await gistWrite(GIST_FILENAME, gistCache, true).catch(e => console.error("[store] gist push 失败:", e.message)); }
  } else {
    const users = await loadUsers();
    const idx = users.findIndex(x => x.id === u.id);
    if (idx >= 0) { users[idx] = u; saveUsers(users); }
  }
}
export async function deleteUserById(id) {
  if (usingMongo) { const r = await UserModel.deleteOne({ id }); return r.deletedCount > 0; }
  if (usingGist) {
    const before = gistCache.length;
    gistCache = gistCache.filter(u => u.id !== id);
    if (gistCache.length === before) return false;
    await gistWrite(GIST_FILENAME, gistCache, true).catch(e => console.error("[store] gist push 失败:", e.message));
    return true;
  }
  const users = await loadUsers();
  const filtered = users.filter(u => u.id !== id);
  if (filtered.length === users.length) return false;
  saveUsers(filtered);
  return true;
}

export function hash(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }
export function getClientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || ""; }

// ===== IP 地区解析 (ip2region 离线库, 国内到省/市, 国外到国家) =====
const IP2Region = IP2RegionPkg.default || IP2RegionPkg;
let regionSearcher = null;
try { regionSearcher = new IP2Region(); } catch (e) { console.warn("[geo] ip2region 初始化失败, 地区统计将不可用:", e.message); }
export function resolveRegion(ip) {
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
export function getUtm(q) {
  return {
    utm_source: q.utm_source || "", utm_medium: q.utm_medium || "", utm_campaign: q.utm_campaign || "",
    utm_content: q.utm_content || "", utm_term: q.utm_term || ""
  };
}



// 对外暴露可变状态的活引用(通过 getter/setter,保持模块内仍用裸变量名)
export const store = {
  get db() { return db; }, set db(v) { db = v; },
  get codes() { return codes; }, set codes(v) { codes = v; },
  get promptCache() { return promptCache; }, set promptCache(v) { promptCache = v; },
  get messages() { return messages; }, set messages(v) { messages = v; },
  get ipClaims() { return ipClaims; }, set ipClaims(v) { ipClaims = v; },
  get gistCache() { return gistCache; }, set gistCache(v) { gistCache = v; },
  get usingGist() { return usingGist; }, set usingGist(v) { usingGist = v; },
  get usingMongo() { return usingMongo; }, set usingMongo(v) { usingMongo = v; },
  get UserModel() { return UserModel; }, set UserModel(v) { UserModel = v; },
  get regionSearcher() { return regionSearcher; }, set regionSearcher(v) { regionSearcher = v; },
  get fewShotRecent() { return fewShotRecent; },
  get ipRegHits() { return ipRegHits; },
  get otpStore() { return otpStore; },
  get otpSendIp() { return otpSendIp; },
  get dbSaveTimer() { return dbSaveTimer; }, set dbSaveTimer(v) { dbSaveTimer = v; },
  get dbSaving() { return dbSaving; }, set dbSaving(v) { dbSaving = v; }
};
