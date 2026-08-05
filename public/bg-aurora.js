/*
 * bg-aurora.js — 登录页动态极光背景
 * 参考 build-your-own-x 中「3D Renderer / WebGL」的图形学思路:
 * 用 Canvas 2D 合成出流动的极光色团 + 漂浮粒子 + 邻近连线(星座效果)。
 * - 色团用 radial-gradient + "lighter" 叠加混合,模拟发光流动
 * - 粒子做轻微漂移并围成一个场,邻近粒子连线形成星座网络
 * - 自适应尺寸 / 限制 DPR / 标签页隐藏时暂停 / 尊重 prefers-reduced-motion
 */
(function () {
  var canvas = document.getElementById("bgCanvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var W = 0, H = 0, DPR = 1;
  var blobs = [], particles = [];
  var COLORS = [
    [124, 92, 255],  // 紫
    [255, 91, 155],  // 粉
    [30, 136, 229],  // 蓝
    [0, 188, 212]    // 青
  ];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initBlobs();
    initParticles();
  }

  function initBlobs() {
    blobs = COLORS.map(function (c, i) {
      return {
        color: c,
        r: Math.max(W, H) * rand(0.32, 0.5),
        x: rand(0, W), y: rand(0, H),
        vx: rand(-0.18, 0.18), vy: rand(-0.18, 0.18),
        phase: rand(0, Math.PI * 2),
        speed: rand(0.00025, 0.0006)
      };
    });
  }

  function initParticles() {
    var count = Math.max(28, Math.min(96, Math.floor(W * H / 15000)));
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: rand(0, W), y: rand(0, H),
        vx: rand(-0.28, 0.28), vy: rand(-0.28, 0.28),
        r: rand(0.6, 2.2),
        a: rand(0.18, 0.65)
      });
    }
  }

  function drawAurora(t) {
    // 底色
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0b0820";
    ctx.fillRect(0, 0, W, H);

    // 色团(发光叠加)
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      b.x += b.vx; b.y += b.vy;
      if (b.x < -b.r) b.x = W + b.r;
      if (b.x > W + b.r) b.x = -b.r;
      if (b.y < -b.r) b.y = H + b.r;
      if (b.y > H + b.r) b.y = -b.r;
      var breathe = 0.78 + 0.22 * Math.sin(t * b.speed + b.phase);
      var rr = b.r * breathe;
      var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, rr);
      var col = b.color;
      g.addColorStop(0, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.50)");
      g.addColorStop(0.5, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0.16)");
      g.addColorStop(1, "rgba(" + col[0] + "," + col[1] + "," + col[2] + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawParticles() {
    // 粒子
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; else if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; else if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255," + p.a + ")";
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // 星座连线
    ctx.globalCompositeOperation = "source-over";
    var maxD = 130, maxD2 = maxD * maxD;
    for (var a = 0; a < particles.length; a++) {
      for (var bIdx = a + 1; bIdx < particles.length; bIdx++) {
        var dx = particles[a].x - particles[bIdx].x;
        var dy = particles[a].y - particles[bIdx].y;
        var d2 = dx * dx + dy * dy;
        if (d2 < maxD2) {
          var alpha = (1 - Math.sqrt(d2) / maxD) * 0.10;
          ctx.strokeStyle = "rgba(170,160,255," + alpha + ")";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(particles[a].x, particles[a].y);
          ctx.lineTo(particles[bIdx].x, particles[bIdx].y);
          ctx.stroke();
        }
      }
    }
  }

  var rafId = null;
  function frame(t) {
    drawAurora(t);
    drawParticles();
    rafId = requestAnimationFrame(frame);
  }

  function staticFrame() {
    drawAurora(0);
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255," + p.a + ")";
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
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
