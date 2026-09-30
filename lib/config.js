import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ============================================================
//  全局配置(统一收敛所有环境变量 / 密钥 / 阈值 / 文件路径)
//  ⚠️ 本仓库公开:所有密钥一律从环境变量读取,严禁写死默认值
// ============================================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, "..");

export const PORT = process.env.PORT || 8080;
export const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"); // 开发未配置时随机生成(生产由 render.yaml 注入)
export const PUBLIC_URL = process.env.PUBLIC_URL || "https://fleta-ai.onrender.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "codex2026";

export const DATA_DIR = path.join(ROOT_DIR, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
export const USERS_FILE = path.join(DATA_DIR, "users.json");
export const EVENTS_FILE = path.join(DATA_DIR, "events.json");
export const DB_FILE = path.join(DATA_DIR, "db.json");
export const CODES_FILE = path.join(DATA_DIR, "codes.json");
export const IP_CLAIM_FILE = path.join(DATA_DIR, "ipclaims.json");
export const PROMPTS_FILE = path.join(DATA_DIR, "prompts.json");

export const MONGODB_URI = process.env.MONGODB_URI || "";

// ---- GitHub Gist 持久化(备用联网存储:跨设备 + 重启不丢,无需 Atlas) ----
export const GIST_TOKEN = process.env.USERS_GIST_TOKEN || "";
export const GIST_ID = process.env.USERS_GIST_ID || "";
export const GIST_FILENAME = "flyelep_users.json";
export const CODES_GIST_FILENAME = "flyelep_codes.json";
export const TRACKING_GIST_FILENAME = "flyelep_tracking.json";
export const IP_CLAIM_GIST_FILENAME = "flyelep_ipclaims.json";
export const PROMPTS_GIST_FILENAME = "flyelep_prompts.json";
export const MESSAGES_GIST_FILENAME = "flyelep_messages.json";

// ---- Video-Use 辅助 API (ElevenLabs Scribe) ----
export const VIDEO_USE_API_KEY = process.env.VIDEO_USE_API_KEY || ""; // 密钥只从环境变量读取
export const VIDEO_USE_API_BASE = (process.env.VIDEO_USE_API_BASE || "https://api.elevenlabs.io").replace(/\/$/, "");
export const VIDEO_USE_AUTH_HEADER = process.env.VIDEO_USE_AUTH_HEADER || "xi-api-key";

// ---- 容量阈值 ----
export const MAX_TRACK = 2500;
export const MAX_PROMPTS = 3000;
export const MAX_MESSAGES = 500;

// ---- 防刷限流 ----
export const REG_WINDOW_MS = 10 * 60 * 1000;
export const REG_MAX_PER_IP = 5;

// ---- 邮箱验证码 ----
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_RESEND_MS = 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_SEND_MAX_PER_IP_HOUR = 10;

// ---- 邮件(可插拔:Brevo HTTP / SMTP / Resend) ----
export const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
export const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
export const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true"; // 587 为 STARTTLS,默认 false
export const SMTP_USER = process.env.SMTP_USER || "b55b38001@smtp-brevo.com";
export const SMTP_PASS = process.env.SMTP_PASS || "";
export const SMTP_FROM = process.env.SMTP_FROM || "ww2190790837@gmail.com";
export const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
export const RESEND_FROM = process.env.RESEND_FROM || "Fleta <[email protected]>";
export const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "Fleta";
export const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
export const BREVO_FROM = process.env.BREVO_FROM || "ww2190790837@gmail.com";

// ---- AI(通义 / 智谱 / OpenAI / Gemini / DeepSeek 通用入口) ----
export const AI_API_KEY = process.env.AI_API_KEY || ""; // 密钥只从环境变量读取
export const AI_PROVIDER = (() => {
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
export const AI_MODEL = (() => {
  const envModel = (process.env.AI_MODEL || "").trim();
  const weak = ["glm-4-flash", "qwen-flash", "gemini-2.5-flash"];
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
export const AI_BASE_URL = process.env.AI_BASE_URL || (AI_PROVIDER === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : AI_PROVIDER === "zhipu" ? "https://open.bigmodel.cn/api/paas/v4" : "");
export const AI_VISION_MODEL = process.env.AI_VISION_MODEL || "qwen-vl-max";