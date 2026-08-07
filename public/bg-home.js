/*
 * bg-home.js — 主页动态背景 (深空流动版,重写)
 * 视频定格后仍需持续动感:
 *   - 4 个品牌色光团在屏幕上缓慢平移穿越(环绕边界)
 *   - 一层白色星点持续上浮 + 闪烁
 * 用 screen 混合叠加在定格视频之上,深空风格。
 * DPR 限制 / 隐藏页暂停 / reduced-motion 降级。
 */
(function () {
  var canvas = document.getElementById("bgCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var W = 0, H = 0, DPR = 1;
  var orbs = [];
  var stars = [];
  var rafId = null;
  var last = 0;

  // 品牌色板(深空)
  var COLORS = [
    [124, 92, 255],   // 紫
    [255, 91, 155],   // 粉
    [34, 160, 255],   // 蓝
    [0, 212, 224]     // 青
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initOrbs();
    initStars();
  }

  function initOrbs() {
    orbs = COLORS.map(function (c, i) {
      return {
        color: c,
        r: Math.max(W, H) * rand(0.38, 0.62),
        x: W * ([0.2, 0.75, 0.5, 0.85][i]),
        y: H * ([0.2, 0.3, 0.8, 0.75][i]),
        // 明显可见的平移速度 (px/秒) —— 约 40~90 秒穿越一屏
        vx: rand(-16, 16),
        vy: rand(-12, 12),
        phase: rand(0, Math.PI * 2),
        breathe: rand(0.5, 1.0)
      };
    });
  }

  function initStars() {
    var n = Math.round((W * H) / 11000);
    n = Math.max(50, Math.min(180, n));
    stars = [];
    for (var i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: rand(0.5, 1.8),
        vx: rand(-8, 8),
        vy: rand(-14, -4),        // 缓缓上浮
        a: rand(0.2, 0.85),       // 基础亮度
        tw: rand(0.6, 2.4)        // 闪烁速度
      });
    }
  }

  function frame(t) {
    if (!last) last = t;
    var dt = Math.min((t - last) / 1000, 0.05);
    last = t;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "screen";

    // 色团:缓慢平移穿越 + 呼吸缩放
    for (var i = 0; i < orbs.length; i++) {
      var b = orbs[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // 环绕边界(从另一侧回来),保证持续动
      if (b.x < -b.r) b.x = W + b.r;
      if (b.x > W + b.r) b.x = -b.r;
      if (b.y < -b.r) b.y = H + b.r;
      if (b.y > H + b.r) b.y = -b.r;

      var breathe = 0.82 + 0.18 * Math.sin(t * 0.0006 * b.breathe + b.phase);
      var rr = b.r * breathe;
      var c = b.color;
      var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, rr);
      g.addColorStop(0, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.22)");
      g.addColorStop(0.5, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.10)");
      g.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    // 星点:上浮 + 闪烁(明显动感,几乎不挡文字)
    for (var j = 0; j < stars.length; j++) {
      var s = stars[j];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.y < -6) { s.y = H + 6; s.x = Math.random() * W; }
      if (s.x < -6) s.x = W + 6;
      if (s.x > W + 6) s.x = -6;
      var tw = 0.5 + 0.5 * Math.sin(t * 0.002 * s.tw + s.x);
      var alpha = s.a * tw;
      ctx.fillStyle = "rgba(255,255,255," + alpha.toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    rafId = requestAnimationFrame(frame);
  }

  function staticFrame() {
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "screen";
    for (var i = 0; i < orbs.length; i++) {
      var b = orbs[i];
      var c = b.color;
      var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.22)");
      g.addColorStop(0.5, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.10)");
      g.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0)");
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
    last = 0;
    rafId = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (!reduceMotion && !rafId) {
      last = 0;
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
