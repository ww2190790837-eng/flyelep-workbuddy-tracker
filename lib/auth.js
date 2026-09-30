import bcrypt from "bcryptjs";
import {
  store, requireAuth, findUserByEmail, findUserById, createUser, updateUser, publicUser,
  genCode, otpSendCount, regWindowCount, regHit, saveCodes, gistWrite, getClientIp, saveJSON, validateAvatar
} from "./store.js";
import { OTP_TTL_MS, OTP_RESEND_MS, OTP_MAX_ATTEMPTS, OTP_SEND_MAX_PER_IP_HOUR, IP_CLAIM_FILE } from "./config.js";
import { EMAIL_ENABLED, sendVerificationEmail } from "./mail.js";
import { asyncHandler } from "./middleware.js";

export function mountAuth(app) {
// ===== Auth 路由 =====
app.post("/api/auth/send-code", asyncHandler(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const ip = getClientIp(req);
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))
    return res.status(400).json({ ok: false, error: "请填写正确的邮箱" });
  // 同 IP 每小时发码上限(防脚本轰炸)
  if (otpSendCount(ip) >= OTP_SEND_MAX_PER_IP_HOUR)
    return res.status(429).json({ ok: false, error: "获取验证码过于频繁,请稍后再试" });
  // 同邮箱 60 秒重发冷却
  const prev = store.otpStore.get(email);
  if (prev && Date.now() - prev.lastSentAt < OTP_RESEND_MS) {
    const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - prev.lastSentAt)) / 1000);
    return res.status(429).json({ ok: false, error: "验证码已发送,请 " + wait + " 秒后重试" });
  }
  const code = genCode();
  store.otpStore.set(email, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  const arr = store.otpSendIp.get(ip) || [];
  arr.push(Date.now());
  store.otpSendIp.set(ip, arr);
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
  setTimeout(() => { const o = store.otpStore.get(email); if (o && Date.now() > o.expiresAt) store.otpStore.delete(email); }, OTP_TTL_MS + 1000);
  const resp = { ok: true, dev: !EMAIL_ENABLED, message: EMAIL_ENABLED ? "验证码已发送到你的邮箱(10 分钟内有效)" : "开发模式:验证码已打印到服务器日志" };
  // 如实回显真实发信结果(发信失败也返回 ok:true 让流程可继续,但带 mailOk:false 让前端提示失败)
  if (mailError) { resp.mailError = mailError; resp.mailOk = false; }
  // 仅开发模式(未配置真实邮件发送)回显验证码,便于自测;一旦配置 SMTP/Resend,dev=false,不再返回明文码
  if (!EMAIL_ENABLED) resp.devCode = code;
  res.json(resp);
}));

app.post("/api/auth/register", asyncHandler(async (req, res) => {
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
  const otp = store.otpStore.get(email);
  if (!otp) return res.status(400).json({ ok: false, error: "请先获取邮箱验证码" });
  if (Date.now() > otp.expiresAt) { store.otpStore.delete(email); return res.status(400).json({ ok: false, error: "验证码已过期,请重新获取" }); }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) { store.otpStore.delete(email); return res.status(400).json({ ok: false, error: "验证码尝试次数过多,请重新获取" }); }
  if (String(code || "") !== otp.code) { otp.attempts++; return res.status(400).json({ ok: false, error: "验证码错误" }); }
  store.otpStore.delete(email); // 验证通过,立即作废,防复用
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ ok: false, error: "该邮箱已注册,请直接登录" });
  regHit(ip); // 记录一次成功注册尝试(限制每 IP 账号数)
  const user = await createUser({ email, password, name });
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
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
}));

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post("/api/auth/change-password", asyncHandler(async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.status(401).json({ ok: false, error: "请先登录" });
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ ok: false, error: "请填写完整" });
  if (!bcrypt.compareSync(oldPassword, u.passwordHash)) return res.status(401).json({ ok: false, error: "当前密码不正确" });
  if (newPassword.length < 6 || newPassword.length > 64) return res.status(400).json({ ok: false, error: "新密码需 6-64 位" });
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
  await updateUser(u);
  res.json({ ok: true });
}));

app.get("/api/auth/me", asyncHandler(async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  res.json({ user: u ? publicUser(u) : null });
}));

// 更新昵称 / 头像(需登录)
app.post("/api/auth/profile", asyncHandler(async (req, res) => {
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
}));

// ===== 邀请码领取 API =====
// 查询当前用户的领取状态
app.get("/api/my-code", asyncHandler(async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.json({ claimed: false, code: null });
  // 在码池中查找该用户已领取的码
  const entry = store.codes.pool.find(c => c.claimedBy === u.id);
  if (entry) return res.json({ claimed: true, code: entry.code, claimedAt: entry.claimedAt });
  res.json({ claimed: false, code: null });
}));

// 公开库存接口:返回邀请码剩余数量(供前端展示)
app.get("/api/code-stock", (req, res) => {
  const total = store.codes.pool.length;
  const claimed = store.codes.pool.filter(c => c.claimedBy).length;
  const available = total - claimed;
  res.json({ total, claimed, available });
});

// 领取邀请码（每个用户限领一次，每码限一人）
app.post("/api/claim-code", asyncHandler(async (req, res) => {
  const u = req.session.userId ? await findUserById(req.session.userId) : null;
  if (!u) return res.status(401).json({ ok: false, error: "请先登录后再领取" });
  const ip = getClientIp(req);
  // 已领取用户直接返回其码(不受 IP 限制,方便换网络回看)
  const mine = store.codes.pool.find(c => c.claimedBy === u.id);
  if (mine) return res.json({ ok: true, code: mine.code, message: "您已领取过邀请码" });
  // 防刷:同一 IP 只能领取一个邀请码(即使换账号也不行);持久化防重启后重刷
  if (store.ipClaims[ip]) {
    return res.status(409).json({ ok: false, error: "该网络环境已领取过邀请码(每 IP 限领 1 个),请勿重复领取", code: store.ipClaims[ip] });
  }
  // 从池中分配一个未使用的码
  const available = store.codes.pool.find(c => !c.claimedBy);
  if (!available) return res.json({ ok: false, error: "邀请码已发完，请联系客服" });
  available.claimedBy = u.id;
  available.claimedAt = new Date().toISOString();
  // 记录该 IP 已领(核心防刷)
  store.ipClaims[ip] = available.code;
  if (store.usingGist) { try { await gistWrite(IP_CLAIM_GIST_FILENAME, store.ipClaims); } catch (e) { console.error("[ipclaims] 落盘失败:", e.message); } }
  else saveJSON(IP_CLAIM_FILE, store.ipClaims);
  await saveCodes();
  res.json({ ok: true, code: available.code, message: "领取成功" });
}));

}
