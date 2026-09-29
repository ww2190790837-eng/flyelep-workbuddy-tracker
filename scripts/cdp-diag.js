// 诊断：光标下方元素链的 overflow / 可滚性 + 谁注册了 wheel 监听
const PAGE = process.argv[2];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // 在任何页面脚本之前拦截 addEventListener，记录谁监听了 wheel / touchmove
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__wheelListeners = [];
      var _add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, fn, opt){
        if (type === 'wheel' || type === 'touchmove' || type === 'mousewheel'){
          try { window.__wheelListeners.push(String(this === window ? 'window' : (this.tagName||this.constructor.name)) + ':' + type + ':' + (opt && opt.capture ? 'cap' : 'bub') + ':' + (opt && opt.passive === false ? 'nonpassive' : 'passive')); } catch(e){}
        }
        return _add.apply(this, arguments);
      };
    `
  });

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await sleep(6500);

  await evalJs(`document.querySelector('.mf-pill[data-open="capabilities"]').click(); true`);
  await sleep(1200);

  const diag = await evalJs(`(function(){
    var el = document.elementFromPoint(700,500);
    var chain = [];
    while (el && chain.length < 9){
      var cs = getComputedStyle(el);
      chain.push({
        t: el.tagName + '.' + String(el.className||'').split(' ')[0],
        oy: cs.overflowY, ox: cs.overflowX, pos: cs.position,
        sH: el.scrollHeight, cH: el.clientHeight
      });
      el = el.parentElement;
    }
    var h = document.getElementById('toolHost');
    var old = h.scrollTop; h.scrollTop = 300; var prog = h.scrollTop; h.scrollTop = old;
    return JSON.stringify({
      chain: chain,
      hostProgrammaticScroll: prog,
      scrollingElement: document.scrollingElement ? document.scrollingElement.tagName : null,
      wheelListeners: window.__wheelListeners
    });
  })()`);
  console.log('DIAG ' + diag);
  ws.close();
  console.log('DONE');
}
main().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
