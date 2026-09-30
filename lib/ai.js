import { AI_API_KEY, AI_PROVIDER, AI_MODEL, AI_BASE_URL, AI_VISION_MODEL } from "./config.js";

// ===== AI 模型调用层(OpenAI 兼容 / Gemini / DeepSeek / 通义视觉候选链) =====

// OpenAI 兼容调用(支持多图 vision + 纯文本,支持自定义 base URL 如智谱/通义/DeepSeek)
// contentParts: [{type:"image_url",image_url:{url}}, {type:"text",text}]
// temperature 可选:提示词创作类调用传 0.85 提多样性;帧描述/聊天保持默认 0.7 保稳定
export async function callOpenAIChat(model, systemPrompt, contentParts, maxTokens, temperature = 0.7) {
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
export function visionCandidates() {
  const fb = (process.env.AI_VISION_FALLBACK || "").split(",").map(s => s.trim()).filter(Boolean);
  const isDash = AI_PROVIDER === "qwen" || /\/dashscope/.test(AI_BASE_URL || "");
  const isZhipu = AI_PROVIDER === "zhipu" || /bigmodel\.cn/.test(AI_BASE_URL || "");
  const isDeepseek = AI_PROVIDER === "deepseek" || /deepseek\.com/.test(AI_BASE_URL || "");
  const primary = AI_VISION_MODEL
    || (isDash ? "qwen3-vl-plus" : isZhipu ? "glm-4v-flash" : isDeepseek ? "deepseek-v4-flash-vision-exp" : (AI_MODEL || "gpt-4o-mini"));
  const builtin = isDash
    ? ["qwen-vl-plus-latest", "qwen3-vl-plus", "qwen-vl-plus", "qwen2.5-vl-72b-instruct"]
    : isZhipu ? ["glm-4v-flash", "glm-4.6v-flash"]
    : isDeepseek ? ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash"] : [];
  return [...new Set([primary, ...fb, ...builtin])];
}

// Gemini API 调用(支持多图,parts 为 inlineData/text 数组)
export async function callGemini(parts, systemText, maxTokens) {
  const model = AI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${AI_API_KEY}`;
  const contents = [{ role: "user", parts: [{ text: systemText }, ...parts] }];
  const body = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error?.message || `Gemini API ${r.status}`); }
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// DeepSeek API 调用(OpenAI 兼容,支持图文混合;contentParts 为 [{type:"image_url",...},{type:"text",...}] 或纯字符串)
export async function callDeepSeek(contentParts, systemPrompt, maxTokens) {
  const model = AI_MODEL || "deepseek-v4-flash";
  const url = (AI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "") + "/chat/completions";
  let content = contentParts;
  if (Array.isArray(content) && content.length && content.every(p => p && p.type === "text")) {
    content = content.map(p => p.text).join("\n");
  }
  const body = { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content }], temperature: 0.7, max_tokens: maxTokens };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error?.message || `DeepSeek API ${r.status}`); }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}