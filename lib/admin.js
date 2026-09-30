import fs from "node:fs";
import {
  store, loadUsers, deleteUserById, publicUser, gistWrite, saveJSON, loadJSON, saveUsers
} from "./store.js";
import { PUBLIC_URL, DB_FILE, CODES_FILE, IP_CLAIM_FILE, USERS_FILE, PROMPTS_FILE } from "./config.js";
import { requireAdmin, asyncHandler } from "./middleware.js";

export function mountAdmin(app) {
// ===== Admin(原有)=====
app.get("/admin/api/stats", requireAdmin, asyncHandler(async (req, res) => {
  const users = await loadUsers();
  res.json({
    total: store.db.visits.length,
    unique: store.db.visits.filter(x => x.unique).length,
    clicks: store.db.clicks.length,
    cvr: store.db.visits.length ? (store.db.clicks.length / store.db.visits.length * 100).toFixed(2) : "0",
    userCount: users.length,
    bySource: groupBy(store.db.visits, "utm_source", "(direct)"),
    byMedium: groupBy(store.db.visits, "utm_medium", "(none)"),
    byCampaign: groupBy(store.db.visits, "utm_campaign", "(none)"),
    byContent: groupBy(store.db.visits, "utm_content", "(none)"),
    clicksByTarget: groupBy(store.db.clicks, "target", "(unknown)"),
    byRegion: groupBy(store.db.visits, "region", "(未知/历史)"),
    clicksByRegion: groupBy(store.db.clicks, "region", "(未知/历史)"),
    regionCount: new Set([...store.db.visits, ...store.db.clicks].map(x => x.region).filter(x => x && x !== "未知" && x !== "内网/本地")).size,
    recent: store.db.visits.slice(-50).reverse(),
    recentClicks: store.db.clicks.slice(-50).reverse(),
    byDay: groupByDay(store.db.visits),
    persist: store.usingGist ? "gist" : "local",
    publicUrl: PUBLIC_URL,
    publicHost: req.get("host"),
    promptCount: store.promptCache.length,
    promptModes: groupBy(store.promptCache, "mode", "(未知)")
  });
}));
// 提示词语料库查看(后台)
app.get("/admin/api/prompts", requireAdmin, asyncHandler(async (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const mode = req.query.mode || "";
  let list = store.promptCache;
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
    total, page, pageSize, items, all: store.promptCache.length,
    createCount: store.promptCache.filter(p => p.mode !== "reverse").length,
    reverseCount: store.promptCache.filter(p => p.mode === "reverse").length,
    withImageCount: store.promptCache.filter(p => (p.imagesCount || 0) > 0).length
  });
}));
// 提示词语料库导出 CSV(后台)
app.get("/admin/api/export-prompts.csv", requireAdmin, asyncHandler(async (req, res) => {
  const header = "ts,mode,duration,imagesCount,idea,prompt\n";
  const rows = store.promptCache.map(p => [
    new Date(p.ts).toISOString(), p.mode, p.duration, p.imagesCount,
    `"${(p.idea || "").replace(/"/g, '""').replace(/[\n\r]+/g, " ")}"`,
    `"${(p.prompt || "").replace(/"/g, '""').replace(/[\n\r]+/g, " ")}"`
  ].join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=fleta_prompts_" + Date.now() + ".csv");
  res.send("﻿" + header + rows);
}));
// 清空提示词语料库(后台,谨慎)
app.delete("/admin/api/prompts", requireAdmin, asyncHandler(async (req, res) => {
  const before = store.promptCache.length;
  store.promptCache = [];
  if (store.usingGist) { try { await gistWrite(PROMPTS_GIST_FILENAME, store.promptCache); } catch (e) { console.error("[prompts] 清空落盘失败:", e.message); } }
  else { try { fs.writeFileSync(PROMPTS_FILE, "[]"); } catch (e) {} }
  res.json({ ok: true, cleared: before });
}));
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
app.get("/admin/api/reset", requireAdmin, asyncHandler(async (req, res) => {
  if (req.query.confirm !== "yes") return res.status(400).send("add ?confirm=yes");
  store.db = { visits: [], clicks: [] };
  if (store.usingGist) {
    // 强制立即落盘:清掉 pending 的 debounce 定时器并直接写 Gist(绕过 persistDBToGist 的 dbSaving 锁),
    // 确保清空一定写进 Gist,否则重启时旧 tracking 会从 Gist 复活。
    try {
      if (store.dbSaveTimer) { clearTimeout(store.dbSaveTimer); store.dbSaveTimer = null; }
      await gistWrite(TRACKING_GIST_FILENAME, store.db);
    } catch (e) { console.error("[tracking] reset 落盘失败:", e.message); }
  } else saveJSON(DB_FILE, store.db);
  res.json({ ok: true });
}));
// 强制用本地正确码表覆盖 Gist + 清除所有历史领取记录(码错时使用)
app.get("/admin/api/resync-codes", requireAdmin, asyncHandler(async (req, res) => {
  if (req.query.confirm !== "yes") return res.status(400).send("add ?confirm=yes");
  // 1) 从本地文件重新加载正确码表(修正 OCR 错误后)
  const fresh = loadJSON(CODES_FILE, { pool: [] });
  // 2) 清除所有领取记录(之前领的是错的码,不算)
  fresh.pool.forEach(c => { c.claimedBy = null; c.claimedAt = null; });
  store.codes = fresh;
  if (store.usingGist) {
    try {
      await gistWrite(CODES_GIST_FILENAME, store.codes, true);
      console.log(`[codes] 已强制同步 ${store.codes.pool.length} 个正确码到 Gist(全部未领)`);
    } catch (e) { return res.status(500).json({ ok: false, error: "Gist 同步失败: " + e.message }); }
  }
  // 3) 清除所有已领用户的 claimedCode(让他们可以重新领正确的码)
  let cleared = 0;
  const allUsers = store.usingGist ? store.gistCache : loadJSON(USERS_FILE, []);
  for (const u of allUsers) {
    if (u.claimedCode) { u.claimedCode = null; cleared++; }
  }
  if (store.usingGist && cleared > 0) {
    try { await gistWrite(GIST_FILENAME, allUsers, true); } catch (e) { console.error("[users] 清除 claimedCode 失败:", e.message); }
  } else if (!store.usingGist && cleared > 0) {
    saveUsers(allUsers);
  }
  // 4) 清除 IP 领码记录(之前领的是错的码,且让被正确码的用户能重新领)
  const prevIpClaims = Object.keys(store.ipClaims).length;
  store.ipClaims = {};
  if (store.usingGist) { try { await gistWrite(IP_CLAIM_GIST_FILENAME, store.ipClaims); } catch (e) { console.error("[ipclaims] 清除失败:", e.message); } }
  else saveJSON(IP_CLAIM_FILE, store.ipClaims);
  res.json({ ok: true, totalCodes: store.codes.pool.length, clearedUsers: cleared, clearedIpClaims: prevIpClaims });
}));
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

app.get("/admin/api/users", requireAdmin, asyncHandler(async (req, res) => {
  const users = await loadUsers();
  res.json(users.map((u) => ({
    id: u.id, email: u.email, name: u.name, plan: u.plan, role: u.role,
    avatar: u.avatar || null,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, loginCount: u.loginCount
  })));
}));

app.delete("/admin/api/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const ok = await deleteUserById(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "用户不存在" });
  res.json({ ok: true });
}));

}
