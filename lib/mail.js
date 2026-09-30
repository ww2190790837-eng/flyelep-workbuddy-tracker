import nodemailer from "nodemailer";
import { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, RESEND_API_KEY, RESEND_FROM, MAIL_FROM_NAME, BREVO_API_KEY, BREVO_FROM } from "./config.js";

// ===== 邮件发送(可插拔:Brevo HTTP(优先,443 端口) / SMTP / Resend / 开发回退) =====
let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    mailer = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 10000,
      socketTimeout: 15000,
      pool: true, maxConnections: 5
    });
    console.log("[mail] 已启用 SMTP 发送器");
  } catch (e) { console.error("[mail] SMTP 初始化失败:", e.message); }
} else if (RESEND_API_KEY) {
  console.log("[mail] 已启用 Resend 发送器");
} else {
  console.warn("[mail] 未配置 SMTP/Resend/Brevo,邮件不会真实发送(开发模式:验证码打印到服务器日志)");
}
export const EMAIL_ENABLED = !!(mailer || RESEND_API_KEY || BREVO_API_KEY);

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

export async function sendMail(to, subject, html) {
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

export async function sendVerificationEmail(email, code) {
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:28px;background:#0f1226;color:#e6e8f0;border-radius:14px">
    <h2 style="margin:0 0 8px;color:#fff">验证你的邮箱</h2>
    <p style="color:#aab;line-height:1.7;margin:0 0 18px">欢迎注册 Fleta，以下是你的邮箱验证码（10 分钟内有效）：</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#7c5cff;background:#1b1f3a;padding:18px 20px;border-radius:12px;text-align:center;margin-bottom:18px">${code}</div>
    <p style="color:#889;font-size:13px;margin:0">如非本人操作，请忽略此邮件。验证码请勿透露给他人。</p>
  </div>`;
  await sendMail(email, "【Fleta】你的邮箱验证码", html);
}