// 抓目标页面的 JS 异常 / console 错误，并检查滚轮接管是否真的挂上了
const PAGE = process.argv[2];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('EXCEPTION: ' + (d.exception && d.exception.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      errors.push('CONSOLE.' + m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push('LOG: ' + m.params.entry.text + ' @' + (m.params.entry.url || ''));
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(7000);

  await evalJs(`document.querySelector('.mf-pill[data-open="capabilities"]').click(); true`);
  await sleep(1000);

  // 关键：滚轮接管是否挂上 + deltaMode + 相关元素状态
  const probe = await evalJs(`(function(){
    var host=document.getElementById('toolHost');
    var rb=document.getElementById('readerBody');
    var ev=new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true});
    rb.dispatchEvent(ev);
    return JSON.stringify({
      newVersion: !!document.getElementById('toolSheet'),
      hasManualWheel: /手动接管/.test(document.documentElement.innerHTML),
      deltaAtStart: 0,
      /* 再测：手动接管的位移是否发生 */
      rbScrollTopBefore: rb.scrollTop,
      rbScrollTopAfter: rb.scrollTop,
      rbSH: rb.scrollHeight, rbCH: rb.clientHeight,
      preventedByHandler: ev.defaultPrevented
    });
  })()`);
  console.log('PROBE ' + probe);
  console.log('ERRORS(' + errors.length + '):');
  errors.slice(0, 12).forEach(e => console.log('  - ' + e.slice(0, 240)));
  ws.close();
  console.log('DONE');
}
main().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
