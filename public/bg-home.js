/*
 * bg-home.js — 主页动态背景 (浅色流动光晕版)
 * 风格:4 个大色团在浅色底上缓慢漂移 + 呼吸,像高端 SaaS 落地页的柔光流云。
 * 无粒子、无波浪,干净通透。浅色主题 / DPR 限制 / 隐藏页暂停 / reduced-motion 降级。
 */
(function () {
  var canvas = document.getElementById("bgCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var W = 0, H = 0, DPR = 1;
  var blobs = [];
  var rafId = null;

  // 品牌色板 (柔和版,浅色底上不刺眼)
  var COLORS = [
    [120, 92, 255],   // 紫
    [255, 120, 170],  // 粉
    [90, 160, 240],   // 蓝
    [80, 200, 220]    // 青
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initBlobs();
  }

  function initBlobs() {
    blobs = COLORS.map(function (c, i) {
      return {
        color: c,
        // 大半径,占屏 45%-72%
        r: Math.max(W, H) * rand(0.45, 0.72),
        // 起始位置:四角 + 中间分布
        x: W * ([0.15, 0.8, 0.5, 0.85][i]),
        y: H * ([0.15, 0.25, 0.85, 0.8][i]),
        // 极慢漂移
        vx: rand(-0.12, 0.12),
        vy: rand(-0.12, 0.12),
        phase: rand(0, Math.PI * 2),
        // 呼吸速度 (很慢)
        speed: rand(0.00018, 0.0005),
        // 漂移幅度
        amp: rand(0.08, 0.14)
      };
    });
  }

  function frame(t) {
    // 浅色底
    ctx.fillStyle = "#fafafe";
    ctx.fillRect(0, 0, W, H);

    // 正常混合 (浅色底不能用 lighter,会发白)
    ctx.globalCompositeOperation = "source-over";
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      // 缓慢漂移 (带正弦摆动,不是直线走)
      var ox = Math.sin(t * b.speed * Math.PI * 2 + b.phase) * b.amp;
      var oy = Math.cos(t * b.speed * Math.PI * 2 + b.phase * 1.3) * b.amp;
      var cx = b.x + ox * W;
      var cy = b.y + oy * H;
      // 呼吸缩放
      var breathe = 0.82 + 0.18 * Math.sin(t * b.speed + b.phase);
      var rr = b.r * breathe;
      var col = b.color;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.42)");
      g.addColorStop(0.45, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.20)");
      g.addColorStop(0.75, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.09)");
      g.addColorStop(1, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    rafId = requestAnimationFrame(frame);
  }

  function staticFrame() {
    ctx.fillStyle = "#fafafe";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var col = b.color;
      var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.42)");
      g.addColorStop(0.45, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.20)");
      g.addColorStop(0.75, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.09)");
      g.addColorStop(1, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function start() {
    resize();
    if (reduceMotion) { staticFrame(); return; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }

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
