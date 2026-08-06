/*
 * bg-home.js — 主页动态背景 v2 (明显动态版)
 * 特点:大颗粒星尘拖尾 + 呼吸脉动色团 + 极光波浪 + 鼠标引力
 * 浅色主题 / DPR限制 / 隐藏页暂停 / reduced-motion 降级
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
  var time = 0;

  // 品牌色板
  var PALETTE = [
    [91, 59, 255],    // 紫
    [255, 91, 155],   // 粉
    [30, 136, 229],   // 蓝
    [0, 188, 212],    // 青
    [255, 107, 53]    // 橙
  ];

  // ---- value-noise ----
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
    return f;
  }
  function angleAt(x, y, t) {
    var n = fbm(x * 0.0018, y * 0.0018, t * 0.05);
    return n * Math.PI * 4.5;
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---- 尺寸 ----
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

  // ---- 粒子 (更少但更大更亮,带明显拖尾) ----
  function initParticles() {
    var count = Math.max(80, Math.min(220, Math.floor(W * H / 6000)));
    particles = [];
    for (var i = 0; i < count; i++) {
      var ci = (Math.random() * PALETTE.length) | 0;
      particles.push({
        x: rand(0, W), y: rand(0, H),
        px: 0, py: 0,
        color: PALETTE[ci],
        speed: rand(0.6, 1.8),
        size: rand(1.5, 3.2),
        life: rand(80, 260),
        trail: [] // 拖尾点
      });
    }
  }

  // ---- 呼吸脉动色团 (明显移动+缩放) ----
  var blobs = [
    { c: PALETTE[0], x: 0.18, y: 0.14, r: 0.38, phase: 0 },
    { c: PALETTE[1], x: 0.82, y: 0.22, r: 0.35, phase: 2.1 },
    { c: PALETTE[2], x: 0.45, y: 0.82, r: 0.40, phase: 4.2 },
    { c: PALETTE[3], x: 0.88, y: 0.78, r: 0.32, phase: 1.3 },
    { c: PALETTE[4], x: 0.12, y: 0.70, r: 0.28, phase: 3.3 }
  ];

  function drawBlobs(t) {
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      // 明显的圆周漂移
      var ox = Math.sin(t * 0.35 + b.phase) * 0.12;
      var oy = Math.cos(t * 0.28 + b.phase * 1.3) * 0.10;
      // 呼吸缩放
      var breath = 1 + Math.sin(t * 0.5 + b.phase * 0.7) * 0.18;
      var cx = (b.x + ox) * W;
      var cy = (b.y + oy) * H;
      var rr = b.r * breath * Math.max(W, H);

      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      var col = b.c;
      g.addColorStop(0, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.22)");
      g.addColorStop(0.4, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.10)");
      g.addColorStop(0.7, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.04)");
      g.addColorStop(1, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---- 极光波浪 (底部流动光带) ----
  function drawAurora(t) {
    for (var wave = 0; wave < 3; wave++) {
      var baseY = H * (0.65 + wave * 0.12);
      var amp = 40 + wave * 20;
      var freq = 0.003 - wave * 0.0006;
      var speed = 0.0008 + wave * 0.0003;
      var col = PALETTE[wave % PALETTE.length];

      ctx.beginPath();
      ctx.moveTo(0, H);
      for (var x = 0; x <= W; x += 8) {
        var y = baseY +
          Math.sin(x * freq + t * speed * 1000 + wave) * amp +
          Math.sin(x * freq * 2.3 + t * speed * 700 + wave * 2) * (amp * 0.45);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();

      var g = ctx.createLinearGradient(0, baseY - amp, 0, H);
      g.addColorStop(0, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      g.addColorStop(0.4, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.06)");
      g.addColorStop(0.7, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.03)");
      g.addColorStop(1, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  // ---- 主渲染循环 ----
  function frame(ts) {
    time = ts * 0.001;
    // 半透明擦除 → 形成拖尾
    ctx.fillStyle = "rgba(250,250,254,0.12)";
    ctx.fillRect(0, 0, W, H);

    // 1) 脉动色团 (最底层,慢)
    drawBlobs(time);

    // 2) 极光波浪
    drawAurora(time);

    // 3) 粒子 + 拖尾
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var a = angleAt(p.x, p.y, time);

      // 鼠标吸引
      var dx = mouse.x - p.x, dy = mouse.y - p.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < 35000) {
        var infl = 1 - Math.sqrt(d2) / 187;
        a += Math.atan2(dy, dx) * infl * 0.7;
      }

      // 记录拖尾
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 10) p.trail.shift();

      p.px = p.x; p.py = p.y;
      p.x += Math.cos(a) * p.speed;
      p.y += Math.sin(a) * p.speed;
      p.life--;

      // 重生
      if (p.life <= 0 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) {
        p.x = rand(0, W); p.y = rand(0, H);
        p.px = p.x; p.py = p.y;
        p.trail = [];
        p.life = rand(80, 260);
      }

      // 画拖尾线
      var c = p.color;
      if (p.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(p.trail[0].x, p.trail[0].y);
        for (var t = 1; t < p.trail.length; t++) {
          ctx.lineTo(p.trail[t].x, p.trail[t].y);
        }
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.18)";
        ctx.lineWidth = p.size * 0.6;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      // 画粒子头 (发光圆点)
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.50)";
      ctx.fill();

      // 发光晕
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.10)";
      ctx.fill();
    }

    rafId = requestAnimationFrame(frame);
  }

  // ---- 静态降级 ----
  function staticFrame() {
    ctx.fillStyle = "#fafafe";
    ctx.fillRect(0, 0, W, H);
    drawBlobs(0);
    drawAurora(0);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var c = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.30)";
      ctx.fill();
    }
  }

  // ---- 启动 ----
  function start() {
    resize();
    if (reduceMotion) { staticFrame(); return; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }

  // ---- 事件 ----
  window.addEventListener("pointermove", function (e) {
    mouse.x = e.clientX; mouse.y = e.clientY;
  }, { passive: true });
  window.addEventListener("pointerleave", function () {
    mouse.x = -9999; mouse.y = -9999;
  });

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
