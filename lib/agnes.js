import express from "express";
import multer from "multer";
import fs from "node:fs";
import { nanoid } from "nanoid";
import path from "node:path";
import { requireAuth } from "./store.js";
import { ROOT_DIR } from "./config.js";


export function mountAgnes(app) {
// ===== Agnes Video 2.5 Flash (OpenAI Videos 兼容, 异步任务) =====
// Render Blueprint 不注入自定义环境变量, 故写死兜底; key 优先用 env
const AGNES_API_KEY = process.env.AGNES_API_KEY || "";  // ⚠️ 只从 Render 环境变量读取。本仓库是公开的，绝不能把密钥写进代码（旧 key 就是因为被提交到公开仓库而失效）
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || "https://api.agnes-ai.cn/v1";  // 国内站；国际站是 https://apihub.agnes-ai.com/v1（两站 key 不通用）
const AGNES_VIDEO_MODEL = process.env.AGNES_VIDEO_MODEL || "agnes-video-2.5-flash";  // 官方文档(agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)接入清单:模型 ID 用 agnes-video-2.5-flash;size 固定 "720P";reference 模式 images≤5 / audios≤3 / 不支持 videos;seconds "4"-"12";n=1;查询 /agnesapi?video_id=&model_name=agnes-video-2.5-flash
const AGNES_RETRIEVE_URL = process.env.AGNES_RETRIEVE_URL || "https://api.agnes-ai.cn/agnesapi";

// ===== Agnes Video 2.5 Flash 代理(API Key 仅存服务端,绝不暴露给前端) =====
// 已并入主页区块(#agnes-video),不再有独立页;旧 /agnes-video 链接兼容跳到主页锚点
app.get(["/agnes-video", "/agnes-video.html"], (req, res) => {
  res.redirect("/#agnes-video");
});
/* 上游鉴权失败时给出「可操作」的提示。
   上游只会回 "Invalid token"，用户看到完全不知道怎么办 —— 这属于运维问题，不该让用户猜。 */
/* 🔴 实测 Agnes 上游的错误体有 **3 种形态**，只读 error.message 会把前两种的真实原因吞掉，
   前端就只剩兜底文案「Agnes 请求失败 (400)」，用户完全无从下手：
     1) Flash 专属参数校验 : {"detail":"size must be 720P"}
     2) 通用参数校验       : {"code":"invalid_request","message":"aspect_ratio 必须是 ...","data":{"param":"aspect_ratio"}}
     3) 鉴权/限流/通用错误  : {"error":{"message":"...","type":"AgnesAI_error","code":"rate_limit_exceeded"}} */
function agnesUpstreamMsg(j) {
  if (!j || typeof j !== "object") return "";
  return String(
    (j.error && (j.error.message || j.error.code)) ||
    j.message ||
    j.detail ||
    ""
  ).trim();
}
/* 把上游的英文/生硬报错翻成用户能照做的话；认不出来就原样透出（至少不再只给个状态码） */
function agnesFriendly(raw) {
  const m = String(raw || "");
  if (/size must be 720P/i.test(m)) return "分辨率参数不受支持：Agnes Video 2.5 Flash 固定只能输出 720P。";
  if (/images length must not exceed 5/i.test(m)) return "参考图片最多 5 张，请删掉多余的再试。";
  if (/audios length must not exceed 3/i.test(m)) return "参考音频最多 3 段，请删掉多余的再试。";
  if (/videos is not supported/i.test(m)) return "Flash 版本不支持「参考视频」输入，请改用参考图片或参考音频。";
  if (/aspect_ratio/i.test(m)) {
    return "画幅参数不受支持：Agnes 只接受 21:9、16:9、4:3、1:1、3:4、9:16 六种（你选的这种它不认）。请换个画幅再试。";
  }
  if (/first_frame|last_frame/i.test(m)) return "首尾帧模式至少要提供首帧或尾帧其中一张图片。";
  if (/(images|audios).*(required|not be empty|至少)/i.test(m)) return "图片参考模式至少要上传 1 张参考图片或 1 段参考音频。";
  if (/mode must be|invalid mode|mode 必须/i.test(m)) return "生成模式参数不合法（只支持 text / keyframe / reference）。请刷新页面后重试。";
  return m;
}
function agnesErrText(status, j) {
  const raw = agnesUpstreamMsg(j);
  if (status === 429 || /rate_limit_exceeded|过于频繁|频率超过限制|rate.?limit/i.test(raw)) {
    return "请求过于频繁：Agnes 免费套餐有每分钟请求数（RPM）限制。等约 1 分钟再点一次即可；如需更高并发，可在 Agnes 控制台升级 Token Plan。"
         + "（本条不是密钥或配置问题）";
  }
  if (status === 401 || /invalid token|no valid token|token not provided|unauthorized|无效的令牌/i.test(raw)) {
    return "服务端 Agnes 密钥已失效（上游返回 401 Invalid token）。请管理员到 apihub.agnes-ai.com 重新获取密钥，"
         + "在 Render 的 Environment 里更新 AGNES_API_KEY 后重新部署即可恢复（无需改代码）。";
  }
  const friendly = agnesFriendly(raw);
  if (friendly) return friendly;
  return "Agnes 请求失败 (" + status + ")：上游没有返回具体原因。请稍后重试；若持续出现，把本条连同时间告知管理员查 Render 日志。";
}

/* Agnes 密钥自检：打开 /api/agnes-video/health 就能看到上游对当前密钥的真实判定（中文说明） */
/* 未配置密钥时直接给出明确提示，不必白跑一趟上游 */
app.get("/api/agnes-video/config", (req, res) => {
  res.json({
    configured: !!AGNES_API_KEY,
    keyHead: AGNES_API_KEY.slice(0, 8),
    keyTail: AGNES_API_KEY.slice(-6),
    base: AGNES_BASE_URL,
    retrieve: AGNES_RETRIEVE_URL,
    model: AGNES_VIDEO_MODEL,
    note: AGNES_API_KEY ? "已从 Render 环境变量读到密钥" : "AGNES_API_KEY 未配置：请在 Render → Environment 里设置"
  });
});

app.get("/api/agnes-video/health", async (req, res) => {
  const out = {
    model: AGNES_VIDEO_MODEL,
    base: AGNES_BASE_URL,
    keyHead: String(AGNES_API_KEY || "").slice(0, 8),  // 与控制台列表显示的"开头"一致，便于对照
    keyTail: String(AGNES_API_KEY || "").slice(-6),    // 与控制台列表显示的"结尾"一致
    keyLength: String(AGNES_API_KEY || "").length
  };
  const started = Date.now();
  try {
    const r = await fetch(AGNES_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + AGNES_API_KEY },
      body: JSON.stringify({ model: "agnes-2.5-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 1 })
    });
    const j = await r.json().catch(function () { return {}; });
    out.httpStatus = r.status;
    out.ms = Date.now() - started;
    const msg = (j && j.error && j.error.message) || "";
    if (r.status === 401 || /invalid token|无效的令牌|token not provided/i.test(msg)) {
      out.ok = false;
      out.upstreamMessage = msg;
      out.diagnosis = "密钥无效或已被删除（上游返回 401）。请登录 platform.agnes-ai.com 的控制台 → API Key 页面重新创建一个（完整密钥只在创建时显示一次，请当场复制），再把新值更新到 Render 的 AGNES_API_KEY 环境变量并重新部署。";
    } else if (!r.ok) {
      out.ok = false;
      out.upstreamMessage = msg;
      out.diagnosis = "上游返回 " + r.status + "，非鉴权问题，请查看 upstreamMessage。";
    } else {
      out.ok = true;
      out.diagnosis = "密钥可用，Agnes 上游连通正常。";
    }
  } catch (e) {
    out.ok = false;
    out.diagnosis = "连接上游失败：" + e.message;
  }
  res.json(out);
});

/* 上游只认这 6 种画幅（实测：其它值一律 HTTP 400）。做成白名单，前端万一漏了也不会打到上游 */
const AGNES_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
app.post("/api/agnes-video/create", requireAuth, express.json({ limit: "2mb" }), async (req, res) => {
  const { mode, prompt, seconds, aspect_ratio, seed, first_frame, last_frame, images, audios } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ ok: false, error: "请填写视频描述" });
  const md = ["text", "keyframe", "reference"].indexOf(String(mode)) >= 0 ? String(mode) : "text";
  const ar = AGNES_ASPECTS.indexOf(String(aspect_ratio || "")) >= 0 ? String(aspect_ratio) : "16:9"; // 非法值兜回 16:9，不再喂给上游挨 400
  const sec = /^(?:4|5|6|7|8|9|1[0-2])$/.test(String(seconds || "")) ? String(seconds) : "5";
  const ff = typeof first_frame === "string" ? first_frame.trim() : "";
  const lf = typeof last_frame === "string" ? last_frame.trim() : "";
  const imgs = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, 5);
  const auds = (Array.isArray(audios) ? audios : []).filter(Boolean).slice(0, 3);
  /* 模式必需素材：本地先拦（省一次上游往返，也省免费额度） */
  if (md === "keyframe" && !ff && !lf)
    return res.status(400).json({ ok: false, error: "首尾帧模式至少要上传一张图（首帧或尾帧）再生成。" });
  if (md === "reference" && !imgs.length && !auds.length)
    return res.status(400).json({ ok: false, error: "图片参考模式至少要上传 1 张参考图片或 1 段参考音频再生成。" });
  const body = {
    model: AGNES_VIDEO_MODEL,
    mode: md,
    prompt: String(prompt).trim(),
    seconds: sec, // Flash 仅支持 4–12 秒
    size: "720P", // Flash 固定 720P,其它值会被 400 拒绝
    aspect_ratio: ar,
    n: 1
  };
  if (seed !== undefined && seed !== null && seed !== "" && Number.isFinite(Number(seed))) body.seed = Number(seed);
  if (md === "keyframe") {
    if (ff) body.first_frame = ff;
    if (lf) body.last_frame = lf;
  } else if (md === "reference") {
    /* 空数组同样会被上游判非法（要求 images/audios 至少一类非空），所以只在非空时才带上 */
    if (imgs.length) body.images = imgs;
    if (auds.length) body.audios = auds;
  }
  try {
    const r = await fetch(AGNES_BASE_URL + "/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + AGNES_API_KEY },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && j.error)) {
      /* 把上游原始错误体落进 Render 日志（不含密钥），以后排查不必再靠猜 */
      console.error("[agnes create] upstream=" + r.status + " body=" + JSON.stringify(j).slice(0, 800) + " req=" + JSON.stringify(body).slice(0, 300));
      return res.status(r.ok ? 502 : r.status).json({ ok: false, error: agnesErrText(r.status, j) });
    }
    res.json({ ok: true, video_id: (j && (j.video_id || j.id)) || null, raw: j });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});
app.get("/api/agnes-video/status", requireAuth, async (req, res) => {
  const { video_id } = req.query || {};
  if (!video_id) return res.status(400).json({ ok: false, error: "缺少 video_id" });
  try {
    const url = AGNES_RETRIEVE_URL + "?video_id=" + encodeURIComponent(video_id) + "&model_name=" + encodeURIComponent(AGNES_VIDEO_MODEL);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + AGNES_API_KEY } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && j.error)) {
      /* 轮询接口被高频调用，只在「非限流/非鉴权」这类异常时留日志 */
      if (r.status !== 429 && r.status !== 401)
        console.error("[agnes status] upstream=" + r.status + " body=" + JSON.stringify(j).slice(0, 600));
      return res.status(r.ok ? 502 : r.status).json({ ok: false, error: agnesErrText(r.status, j) });
    }
    res.json({
      ok: true,
      status: (j && j.status) || "unknown",
      progress: (j && j.progress) || 0,
      video_url: (j && j.metadata && j.metadata.url) || (j && j.url) || null,
      raw: j
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ===== Agnes 图片上传(首帧/尾帧/参考图) =====
// Agnes 要求素材必须是其服务可公开访问的 HTTPS URL，故本站接收文件后落地 public/uploads/ 并以公网 URL 返回
const UPLOAD_DIR = path.join(ROOT_DIR, "public", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const agnesUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, nanoid(16) + (path.extname(file.originalname) || "").toLowerCase().slice(0, 10))
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB(图片/音频)
  fileFilter: (req, file, cb) => cb(null, /^(image|audio)\//.test(file.mimetype))
}).single("file");
app.post("/api/agnes-upload", requireAuth, (req, res) => {
  agnesUpload(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || "上传失败" });
    if (!req.file) return res.status(400).json({ ok: false, error: "未收到文件" });
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
    const host = req.get("host");
    const url = proto + "://" + host + "/uploads/" + req.file.filename;
    res.json({ ok: true, url, name: req.file.originalname });
  });
});

}
