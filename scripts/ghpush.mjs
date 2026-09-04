// 通过 GitHub Git Data API 推送本地 commit（绕开 github.com:443 被墙，api.github.com 可用）。
// 用法: node scripts/ghpush.mjs "提交说明"
// 前置: 本地已 git add / commit；脚本会把 origin/<branch>..HEAD 的差异推上去并触发 Render 部署。
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const REPO = 'ww2190790837-eng/flyelep-workbuddy-tracker';
const BRANCH = process.env.BRANCH || 'master';
const RENDER_TOKEN = process.env.RENDER_TOKEN || 'rnd_H6TaIL4ZEBtBvZPfSJhrNdisxugY';
const RENDER_SERVICE = process.env.RENDER_SERVICE || 'srv-d9k5uvnavr4c73a97rrg';
const MESSAGE = process.argv[2] || 'update';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

// token 直接取自 git remote，避免二次硬编码
const url = run('git remote get-url origin');
const token = (url.match(/x-access-token:([^@]+)@/) || [])[1] || process.env.GITHUB_TOKEN;
if (!token) { console.error('✗ 拿不到 GitHub token'); process.exit(1); }

const API = 'https://api.github.com';
const HEADERS = {
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'ghpush-script',
};

async function gh(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}\n${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function blobSha(file) {
  const content = readFileSync(file).toString('base64');
  const b = await gh(`/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'base64' }),
  });
  return b.sha;
}

async function main() {
  // 1. 收集 origin..HEAD 的差异
  const diff = run(`git diff --name-status origin/${BRANCH} HEAD`)
    .split('\n').filter(Boolean);

  if (!diff.length) { console.log('没有需要推送的改动'); return; }

  const tree = [];
  let added = 0, modified = 0, deleted = 0;

  for (const line of diff) {
    const [rawStatus, ...paths] = line.split('\t');
    const status = rawStatus.trim();

    if (status.startsWith('R')) {                       // 重命名 = 删旧 + 加新
      const [oldPath, newPath] = paths;
      tree.push({ path: oldPath, mode: '100644', type: 'blob', sha: null });
      tree.push({ path: newPath, mode: '100644', type: 'blob', sha: await blobSha(newPath) });
      added++; deleted++;
      continue;
    }

    const p = paths[0];
    if (status === 'D') {
      tree.push({ path: p, mode: '100644', type: 'blob', sha: null });   // sha:null => 删除
      deleted++;
    } else {
      let mode = '100644';
      try { if (statSync(p).mode & 0o111) mode = '100755'; } catch {}
      tree.push({ path: p, mode, type: 'blob', sha: await blobSha(p) });
      if (status === 'A') added++; else modified++;
    }
  }

  console.log(`改动: +${added} 新增 / ~${modified} 修改 / -${deleted} 删除  (共 ${tree.length} 项)`);

  // 2. 以远端当前 commit 的 tree 为基底创建新 tree
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(`/repos/${REPO}/git/commits/${baseSha}`);
  const newTree = await gh(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });

  // 3. 建 commit 并移动 ref
  const commit = await gh(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: MESSAGE, tree: newTree.sha, parents: [baseSha] }),
  });
  await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });

  console.log(`✓ 已推送 ${commit.sha.slice(0, 7)} -> ${REPO}@${BRANCH}`);
  run(`git update-ref refs/remotes/origin/${BRANCH} ${commit.sha}`);
  console.log('✓ 本地 origin/' + BRANCH + ' 已同步');

  // 4. 触发 Render 部署
  const rd = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RENDER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearCache: 'clear' }),
  });
  const rdText = await rd.text();
  if (!rd.ok) { console.error('✗ Render 触发失败:', rd.status, rdText.slice(0, 300)); return; }
  const deploy = JSON.parse(rdText);
  console.log(`✓ Render 部署已触发: ${deploy.id}`);
  console.log('  面板: https://dashboard.render.com/web/' + RENDER_SERVICE);
}

main().catch((e) => { console.error('✗ 失败:', e.message); process.exit(1); });
