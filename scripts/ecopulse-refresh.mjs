/* 电商脉搏 · 资讯刷新脚本
 *
 * 作用：抓取电商派（国内热点）与雨果跨境（海外/平台政策）的最新文章，
 *       连同新闻页配图一起下载压缩到 public/ecopulse/，并合并进 public/ecopulse-data.js。
 *
 * 用法：npm run refresh:ecopulse
 *       （可选）node scripts/ecopulse-refresh.mjs --max=6  限制本次最多新增条数
 *
 * 特性：按 url 去重（幂等，可反复运行）、图片过小的条目自动丢弃、
 *       手写条目与分类/倒计时配置完整保留。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobePathRaw from "ffprobe-static";

const ffprobePath = typeof ffprobePathRaw === "string" ? ffprobePathRaw : ffprobePathRaw.path;
const execFileAsync = promisify(execFile);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OUT_DIR = path.join("public", "ecopulse");
const DATA_FILE = path.join("public", "ecopulse-data.js");
const MAX_TOTAL = 40;

const argMax = Number((process.argv.find(a => a.startsWith("--max=")) || "--max=8").split("=")[1]) || 8;

/* ---------- 读取现有数据 ---------- */
global.window = {};
new Function(fs.readFileSync(DATA_FILE, "utf8"))();
const OLD_EVENTS = global.window.ECO_EVENTS || [];
const FILTERS = global.window.ECO_FILTERS || [];
const COUNTDOWNS = global.window.ECO_COUNTDOWNS || [];
const seen = new Set(OLD_EVENTS.map(e => e.url));

/* ---------- 通用抓取 ---------- */
async function fetchText(url, timeout = 25000) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", Accept: "text/html,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout)
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

function pickMeta(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : "";
}
function absUrl(u, base) {
  if (/^\/\//.test(u)) return "https:" + u;
  if (/^\//.test(u)) return new URL(base).origin + u;
  return u;
}

/* 列表页：抽取文章链接 + 列表配图 */
const SOURCES = [
  {
    name: "电商派",
    list: "https://www.dsb.cn/",
    linkMatch: /\/p\/[0-9a-z]{16,}/,
    imgMatch: /media\.dsb\.cn\/media\/\d+\/conversions\/cover-800\.(?:png|jpe?g|webp)/,
    regionHint: "cn",
    catHint: "hot"
  },
  {
    name: "雨果跨境",
    list: "https://www.cifnews.com/amazon/policy",
    linkMatch: /\/article\/\d{5,}/,
    imgMatch: /img\.cifnews\.com\/dev\/\d{8}\/[0-9a-f]{32}\.(?:png|jpe?g)/,
    regionHint: "global",
    catHint: "policy"
  }
];

/* 列表页解析：把每条文章链接与它自己的封面图精确配对，避免多条共用同一张图 */
function parseList(html, src) {
  const out = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]{0,1200}?<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const link = absUrl(m[1], src.list);
    const img = absUrl(m[2], src.list);
    if (!src.linkMatch.test(link) || !src.imgMatch.test(img)) continue;
    if (out.some(o => o.link === link)) continue;
    out.push({ link, img });
  }
  return out;
}

const PLATFORM_KEYS = [
  "亚马逊", "TikTok Shop", "TikTok", "Shopee", "Temu", "SHEIN", "希音",
  "淘宝闪购", "淘宝", "天猫", "京东", "拼多多", "抖音", "快手", "小红书",
  "美团", "饿了么", "速卖通", "Lazada", "Shopify", "沃尔玛"
];

function guessPlatform(title, fallback) {
  for (const k of PLATFORM_KEYS) if (title.includes(k)) return k;
  return fallback;
}
function guessCategory(title, def, region) {
  if (/新规|新国标|新标准|政策|监管|合规|标准|规范|办法|规定|整治|处罚|禁令|清关|税|备案|审核|验证|侵权|合规/.test(title)) return "policy";
  if (/大促|旺季|活动|促销|日程|日历|招商|焕新季/.test(title)) return "campaign";
  if (region === "global") return "overseas";
  return "hot";
}
/* 去掉摘要里的站点栏目名、日期时间串，保证卡片文案干净 */
function stripNoise(s) {
  return (s || "")
    .replace(/(?:跨境派|电商行业|互联网头条|跨境前沿|跨境焦点|电商派|雨果跨境|雨果网)\s*/g, "")
    .replace(/20\d\d[-/年]\d{1,2}[-/月]\d{1,2}[日]*\s+\d{1,2}:\d{2}(?::\d{2})?\s*/g, "")
    .replace(/^[一二三四五六七八九十]+、\s*/, "")
    .replace(/^[\s、，,。]+/, "")
    .trim();
}
function slugOf(url) {
  const seg = url.split("?")[0].split("/").filter(Boolean).pop();
  return (url.includes("cifnews") ? "cif-" : url.includes("dsb.cn") ? "dsb-" : "new-") + seg;
}
function cleanTitle(t) {
  return t.replace(/\s*[-|｜–—]\s*(电商派|雨果跨境|雨果网|卖家之家|跨境知道)\s*$/, "").trim();
}
function cleanSummary(s) {
  return (s || "").replace(/\s+/g, " ").replace(/[#&][a-z0-9]+;/gi, "").trim().slice(0, 130);
}

/* ---------- 图片下载 + 压缩 + 尺寸校验 ---------- */
async function downloadImage(url, slug, ref) {
  const raw = path.join(OUT_DIR, slug + ".raw");
  const out = path.join(OUT_DIR, slug + ".jpg");
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Referer: ref, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) throw new Error("图片过小");
    fs.writeFileSync(raw, buf);
    await execFileAsync(ffmpegPath, ["-y", "-loglevel", "error", "-i", raw, "-vf", "scale='min(1600,iw)':-2", "-q:v", "4", out]);
    fs.unlinkSync(raw);
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
    const [w, h] = stdout.trim().split(",").map(Number);
    if (!w || w < 600) { fs.unlinkSync(out); throw new Error("尺寸不足 " + w + "x" + h); }
    return "/ecopulse/" + slug + ".jpg";
  } catch (e) {
    try { if (fs.existsSync(raw)) fs.unlinkSync(raw); } catch {}
    throw e;
  }
}

/* ---------- 主流程 ---------- */
const added = [];

for (const src of SOURCES) {
  let html;
  try {
    html = await fetchText(src.list);
  } catch (e) {
    console.log(`[${src.name}] 列表抓取失败：${e.message}`);
    continue;
  }
  const links = parseList(html, src);
  if (!links.length) console.log(`[${src.name}] 列表未解析到文章`);

  let addedHere = 0; // 每个源的本次新增上限，避免单一源占满
  for (const entry of links) {
    if (addedHere >= argMax) break;
    const url = entry.link;
    if (seen.has(url)) continue;
    let detail;
    try {
      detail = await fetchText(url);
    } catch (e) {
      console.log(`  · 跳过 ${url}（详情抓取失败 ${e.message}）`);
      continue;
    }

    const title = cleanTitle(pickMeta(detail, /<title[^>]*>([\s\S]*?)<\/title>/i));
    if (!title || title.length < 6) continue;

    const ogImg = pickMeta(detail, /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?:_url)?["'][^>]*content=["']([^"']+)["']/i);
    const listImg = entry.img;
    let imgUrl = ogImg && !/favicon|logo|\/static\/img\//i.test(ogImg) ? ogImg : listImg;
    if (!imgUrl || /favicon|logo/i.test(imgUrl)) imgUrl = "";
    if (!imgUrl) { console.log(`  · 跳过「${title}」（无可用配图）`); continue; }
    imgUrl = absUrl(imgUrl.replace(/\?.*$/, ""), url);

    // 页面里会混入往期推荐等旧日期：只取 2025 年之后、且最靠前的那一个（即发布时间）
    const allTimes = [...detail.matchAll(/(20\d\d)[-/年]\s?(\d{1,2})[-/月]\s?(\d{1,2})[日\s]*(?:\s?(\d{1,2}):(\d{2}))?/g)]
      .filter(m => Number(m[1]) >= 2025);
    const timeMatch = allTimes.find(m => m[4]) || allTimes[0];
    if (!timeMatch) { console.log(`  · 跳过「${title}」（无发布时间）`); continue; }
    const p = n => String(n).padStart(2, "0");
    const date = `${timeMatch[1]}-${p(timeMatch[2])}-${p(timeMatch[3])}`;
    const time = timeMatch[4] ? `${p(timeMatch[4])}:${timeMatch[5]}` : "09:00";

    let summary = cleanSummary(
      stripNoise(pickMeta(detail, /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i))
    );
    if (!summary || summary.length < 30) {
      const body = detail.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
      const ps = [...body.matchAll(/<p[^>]*>([\s\S]{0,400}?)<\/p>/gi)]
        .map(m => stripNoise(m[1].replace(/<[^>]+>/g, "")))
        .filter(s => s.length > 25);
      const longer = cleanSummary(ps.slice(0, 2).join(" "));
      if (longer.length > summary.length) summary = longer;
    }
    if (!summary) summary = title;

    const slug = slugOf(url);
    let image;
    try {
      image = await downloadImage(imgUrl, slug, url);
    } catch (e) {
      console.log(`  · 跳过「${title}」（配图失败 ${e.message}）`);
      continue;
    }

    const region = /TikTok|亚马逊|Shopee|Temu|SHEIN|希音|速卖通|Lazada|Shopify|沃尔玛/.test(title) ? "global" : src.regionHint;
    added.push({
      id: slug,
      title,
      summary,
      platform: guessPlatform(title, "行业动态"),
      source: src.name,
      region,
      category: guessCategory(title, src.catHint, region),
      date,
      time,
      tags: [src.name === "电商派" ? "行业热点" : "平台政策"],
      url,
      image
    });
    seen.add(url);
    addedHere++;
    console.log(`  + 新增「${title}」${date} ${time} [${src.name}]`);
  }
}

if (!added.length) {
  console.log("本次没有新增资讯（源站暂无更新或全部已收录）。");
  process.exit(0);
}

/* ---------- 写回数据文件 ---------- */
const merged = [...added, ...OLD_EVENTS].slice(0, MAX_TOTAL);
const q = s => JSON.stringify(s);
const eventsSrc = merged.map(e => {
  const tags = (e.tags || []).map(t => q(t)).join(", ");
  return `  {
    id: ${q(e.id)},
    title: ${q(e.title)},
    summary:
      ${q(e.summary)},
    platform: ${q(e.platform)},
    source: ${q(e.source)},
    region: ${q(e.region)},
    category: ${q(e.category)},
    date: ${q(e.date)},
    time: ${q(e.time)},
    tags: [${tags}],
    url: ${q(e.url)},
    image: ${q(e.image)}
  }`;
}).join(",\n");

const filtersSrc = FILTERS.map(f => `  { key: ${q(f.key)}, label: ${q(f.label)} }`).join(",\n");
const cdSrc = COUNTDOWNS.map(c => `  { name: ${q(c.name)}, date: ${q(c.date)}, platform: ${q(c.platform)} }`).join(",\n");

const file = `/* 电商脉搏 · 全球电商平台政策 / 活动 / 每日热点数据源
 * 由 scripts/ecopulse-refresh.mjs 自动生成 · 最后更新：${new Date().toISOString().slice(0, 19).replace("T", " ")}
 * 每条 news 的 image 均从对应新闻页下载到本地 /ecopulse/ 目录，图文一一配套。
 */
window.ECO_EVENTS = [
${eventsSrc}
];

/* 分类筛选配置 */
window.ECO_FILTERS = [
${filtersSrc}
];

/* 大促倒计时节点 */
window.ECO_COUNTDOWNS = [
${cdSrc}
];
`;
fs.writeFileSync(DATA_FILE, file);
console.log(`\n完成：新增 ${added.length} 条，当前共 ${merged.length} 条，已写入 ${DATA_FILE}`);
