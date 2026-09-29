// 用 CDP 派发「真实」鼠标滚轮事件，读 scrollTop 是否真的变化
// 用法: node cdp-wheel.js <pageUrl>
const PAGE = process.argv[2];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(6000);

  // 打开「核心能力」面板（内容型）
  await evalJs(`document.querySelector('.mf-pill[data-open="capabilities"]').click(); true`);
  await sleep(1200);

  // 真正的滚动区在卡片内部：可见的那个（#readerBody 优先，其次 #workspace）
  const SCROLLER = `(function(){
    var rb=document.getElementById('readerBody');
    if(rb && !rb.hidden && rb.clientHeight) return rb;
    var ws=document.getElementById('workspace');
    if(ws && !ws.hidden && ws.clientHeight) return ws;
    return document.getElementById('toolHost');
  })()`;

  const probe = async (label) => {
    const before = await evalJs(`(${SCROLLER}).scrollTop`);
    // 真实鼠标：先移动到位，再滚
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500, button: 'none' });
    for (let i = 0; i < 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: 130 });
      await sleep(50);
    }
    await sleep(700);
    const after = await evalJs(`(${SCROLLER}).scrollTop`);
    const m = await evalJs(`(function(){var s=(${SCROLLER});return JSON.stringify({which:(s.id||s.className),sH:s.scrollHeight,cH:s.clientHeight,oy:getComputedStyle(s).overflowY})})()`);
    console.log(label, '| scrollTop', before, '->', after, '| 变化', (after - before), '|', m);
  };

  await probe('[内容面板 核心能力]');

  // 切到工具面板再测一次
  await evalJs(`document.querySelector('.mf-pill[data-open="prompt"]').click(); true`);
  await sleep(1000);
  await probe('[工具面板 提示词生成]');

  ws.close();
  console.log('DONE');
}
main().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
