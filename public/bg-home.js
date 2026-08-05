/*
 * bg-home.js — 主页动态背景 (Canvas 流场粒子 + 有机噪声光晕)
 * 比纯 CSS 色块更高级:粒子沿 value-noise 噪声场流动,形成丝状星尘流动;
 * 顶层叠加随噪声缓慢漂移的品牌色光晕;带轻微鼠标交互。
 * 浅色主题适配 + DPR 限制 + 隐藏页暂停 + 尊重 prefers-reduced-motion。
 */
(function () {
  var canvas = document.getElementById("bgCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var W = 0, H = 0, DPR = 1;
  var particles = [];
  var mouse = { x: -9999, y: -9999 };
  var rafId = null;

  // 品牌色板 (rgb)
  var PALETTE = [
    [91, 59, 255],   // 紫
    [255, 91, 155],  // 粉
    [30, 136, 229],  // 蓝
    [0, 188, 212],   // 青
    [255, 107, 53]   // 橙
  ];

  // ---- 轻量 value-noise (fbm, 3 倍频, 第三维当时间) ----
  function hash(x, y) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise2(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var tl = hash(xi, yi), tr = hash(xi + 1, yi);
    var bl = hash(xi, yi + 1), br = hash(xi + 1, yi + 1);
    var u = smooth(xf), v = smooth(yf);
    return (tl * (1 - u) + tr * u) * (1 - v) + (bl * (1 - u) + br * u) * v;
  }
  function fbm(x, y, z) {
    var f = 0, amp = 0.5, freq = 1;
    for (var o = 0; o < 3; o++) {
      f += amp * noise2(x * freq + z * freq * 0.35, y * freq - z * freq * 0.25);
      freq *= 2; amp *= 0.5;
    }
    return f; // ~0..0.875
  }
  function angleAt(x, y, t) {
    var n = fbm(x * 0.0016, y * 0.0016, t * 0.06);
    return n * Math.PI * 4;
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initParticles();
  }

  function initParticles() {
    var count = Math.max(280, Math.min(760, Math.floor(W * H / 2200)));
    particles = [];
    for (var i = 0; i < count; i++) {
      var c = PALETTE[(Math.random() * PALETTE.length) | 0];
      particles.push({
        x: rand(0, W), y: rand(0, H),
        px: 0, py: 0,
        color: c,
        speed: rand(0.5, 1.4),
        life: rand(60, 220)
      });
    }
  }

  // 品牌色光晕 (随噪声缓慢漂移)
  var halos = [
    { c: PALETTE[0], bx: 0.2, by: 0.15, r: 0.45, ph: 0 },
    { c: PALETTE[1], bx: 0.82, by: 0.3, r: 0.4, ph: 2 },
    { c: PALETTE[2], bx: 0.5, by: 0.86, r: 0.42, ph: 4 },
    { c: PALETTE[3], bx: 0.86, by: 0.82, r: 0.35, ph: 1 }
  ];
  function drawHalos(t) {
    for (var i = 0; i < halos.length; i++) {
      var h = halos[i];
      var ox = Math.sin(t * 0.05 + h.ph) * 0.08;
      var oy = Math.cos(t * 0.04 + h.ph) * 0.08;
      var cx = (h.bx + ox) * W, cy = (h.by + oy) * H;
      var rr = h.r * Math.max(W, H);
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      var col = h.c;
      g.addColorStop(0, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.18)");
      g.addColorStop(0.5, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.07)");
      g.addColorStop(1, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function frame(t) {
    var ts = t * 0.001;
    // 浅色擦除 → 形成丝状拖尾
    ctx.fillStyle = "rgba(250,250,254,0.085)";
    ctx.fillRect(0, 0, W, H);
    drawHalos(ts);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var a = angleAt(p.x, p.y, ts);
      // 鼠标轻微吸引
      var dx = mouse.x - p.x, dy = mouse.y - p.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < 26000) {
        var infl = 1 - Math.sqrt(d2) / 161;
        a = a + Math.atan2(dy, dx) * infl * 0.6;
      }
      p.px = p.x; p.py = p.y;
      p.x += Math.cos(a) * p.speed;
      p.y += Math.sin(a) * p.speed;
      p.life--;
      if (p.life <= 0 || p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) {
        p.x = rand(0, W); p.y = rand(0, H); p.px = p.x; p.py = p.y;
        p.life = rand(60, 220);
      }
      var c = p.color;
      ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.32)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    rafId = requestAnimationFrame(frame);
  }

  function staticFrame() {
    ctx.fillStyle = "#fafafe";
    ctx.fillRect(0, 0, W, H);
    drawHalos(0);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var c = p.color;
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.22)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function start() {
    resize();
    if (reduceMotion) { staticFrame(); return; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener("pointermove", function (e) {
    mouse.x = e.clientX; mouse.y = e.clientY;
  }, { passive: true });
  window.addEventListener("pointerleave", function () { mouse.x = -9999; mouse.y = -9999; });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (!reduceMotion && !rafId) {
      rafId = requestAnimationFrame(frame);
    }
  });

  var rzTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(resize, 200);
  });

  start();
})();
