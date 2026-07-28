import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const DATA_DIR = path.join(__dirname,'data');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
const DB_FILE = path.join(DATA_DIR,'db.json');

// simple JSON DB
function loadDb(){
  if(!fs.existsSync(DB_FILE)){return {visits:[],clicks:[]};}
  try{return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));}catch(e){return {visits:[],clicks:[]};}
}
function saveDb(db){fs.writeFileSync(DB_FILE, JSON.stringify(db));}
let db = loadDb();

function hash(s){return crypto.createHash('sha256').update(s).digest('hex').slice(0,16);}
function getClientIp(req){return (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';}
function getUtm(q){
  return {
    utm_source: q.utm_source || '',
    utm_medium: q.utm_medium || '',
    utm_campaign: q.utm_campaign || '',
    utm_content: q.utm_content || '',
    utm_term: q.utm_term || ''
  };
}
function todayStr(){const d=new Date();return d.toISOString().slice(0,10);}

const app = express();
app.use(express.json({limit:'64kb'}));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname,'public'), {index:'index.html', extensions:['html']}));

// tracking beacon
app.get('/t.gif', (req,res)=>{
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const ref = req.headers['referer'] || '';
  const u = getUtm(req.query);
  const vid = (req.cookies && req.cookies.vid) || hash(ip+ua);
  const isUnique = !(req.cookies && req.cookies.vid);
  db.visits.push({ts:Date.now(),ip,ua,referer:ref,path:req.query.p||'',...u,vid,unique:isUnique?1:0});
  if(db.visits.length>20000) db.visits = db.visits.slice(-20000);
  saveDb(db);
  res.set('Content-Type','image/gif');
  res.set('Cache-Control','no-store, no-cache, must-revalidate');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
  if(isUnique){res.cookie('vid', vid, {maxAge:30*24*3600*1000,sameSite:'lax'});}
});

app.post('/api/click', (req,res)=>{
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const vid = (req.cookies && req.cookies.vid) || hash(ip+ua);
  const ref = req.headers['referer'] || '';
  const u = getUtm({...req.query,...req.body});
  const {target,label} = req.body || {};
  db.clicks.push({ts:Date.now(),vid,utm_source:u.utm_source,utm_campaign:u.utm_campaign,target:target||'',label:label||''});
  if(db.clicks.length>20000) db.clicks = db.clicks.slice(-20000);
  saveDb(db);
  res.json({ok:true});
});

function requireAdmin(req,res,next){
  if(req.signedCookies && req.signedCookies.admin==='ok') return next();
  if(req.query.token === ADMIN_PASSWORD){res.cookie('admin','ok',{signed:true,maxAge:7*24*3600*1000});return res.redirect('/admin');}
  res.status(401).send('<h1>401</h1><p>需要管理员密码</p><form method=GET><input name=token placeholder=password autofocus style=padding:8px;font-size:16px><button>进入</button></form>');
}

app.get('/admin', requireAdmin, (req,res)=>{
  res.sendFile(path.join(__dirname,'public','admin.html'));
});

app.get('/admin/api/stats', requireAdmin, (req,res)=>{
  const v = db.visits, c = db.clicks;
  const total = v.length, unique = v.filter(x=>x.unique).length, clicks = c.length;
  function group(arr, key, label='(direct)'){
    const m = new Map();
    for(const x of arr){const k = x[key] || label; m.set(k, (m.get(k)||0)+1);}
    return Array.from(m, ([k,v])=>({k, c:v})).sort((a,b)=>b.c-a.c);
  }
  res.json({
    total, unique, clicks,
    cvr: total ? (clicks/total*100).toFixed(2) : '0',
    bySource: group(v,'utm_source'),
    byMedium: group(v,'utm_medium','(none)'),
    byCampaign: group(v,'utm_campaign','(none)'),
    byContent: group(v,'utm_content','(none)'),
    clicksByTarget: group(c,'target','(unknown)'),
    byDay: (()=>{const m=new Map();for(const x of v){const d=new Date(x.ts).toISOString().slice(0,10);m.set(d,(m.get(d)||0)+1);}return Array.from(m,([k,v])=>({d:k,c:v})).sort((a,b)=>a.d.localeCompare(b.d));})(),
    recent: v.slice(-50).reverse(),
    recentClicks: c.slice(-50).reverse(),
    publicUrl: PUBLIC_URL,
    publicHost: req.get('host')
  });
});

app.get('/admin/api/reset', requireAdmin, (req,res)=>{
  if(req.query.confirm!=='yes') return res.status(400).send('add ?confirm=yes');
  db = {visits:[],clicks:[]}; saveDb(db); res.json({ok:true});
});

app.get('/admin/api/export.csv', requireAdmin, (req,res)=>{
  const v = db.visits;
  const header = ['id','time','ip','utm_source','utm_medium','utm_campaign','utm_content','utm_term','path','referer','is_unique'];
  const esc = (s)=>'"'+String(s==null?'':s).replace(/'"'/g,'""')+'"';
  const lines = [header.join(',')];
  v.forEach((r,i)=>{lines.push([i+1, new Date(r.ts).toISOString(), r.ip, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.path, r.referer, r.unique].map(esc).join(','));});
  res.set('Content-Type','text/csv;charset=utf-8');
  res.set('Content-Disposition','attachment; filename=visits.csv');
  res.send('\\uFEFF'+lines.join('\\n'));
});

app.get('/healthz', (req,res)=>res.json({ok:true,ts:Date.now()}));

app.listen(PORT, '0.0.0.0', ()=>console.log('listening on '+PORT));
