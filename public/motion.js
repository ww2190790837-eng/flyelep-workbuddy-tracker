/* ============================================================================
 * motion.js — Fleta 高级动效层
 *   Lenis(平滑滚动) + GSAP/ScrollTrigger(滚动时间轴) + SplitText(字标拆字)
 *   + WebGL(颗粒 / 扫描线 / 移动扫光 / 鼠标补光)
 *
 * 依据 web-motion-design 技能：
 *   - 只动 transform / opacity（GPU 合成），绝不动 layout 属性
 *   - 标准缓动 cubic-bezier(.4,0,.2,1)；入场 cubic-bezier(0,0,.2,1)
 *   - 微交互 100–200ms、转场 200–400ms、复杂序列 400–700ms
 *   - 夸张要「可感知但不刺眼」：hover 1.03–1.06 而非 1.01
 *   - 尊重 prefers-reduced-motion；触摸设备关闭自定义光标/磁吸
 *
 * 设计要点：脚本未加载 / 库缺失时，页面内容照常可见（不会白屏）。
 * ========================================================================== */
(function () {
  'use strict';

  var docEl = document.documentElement;
  var mq = function (q) { return window.matchMedia ? window.matchMedia(q).matches : false; };
  var REDUCE = mq('(prefers-reduced-motion: reduce)');
  var COARSE = mq('(pointer: coarse)');
  var hasGSAP = typeof window.gsap !== 'undefined';
  var hasST = hasGSAP && typeof window.ScrollTrigger !== 'undefined';
  var hasSplit = hasGSAP && typeof window.SplitText !== 'undefined';

  var EASE = 'power3.out';
  var EASE_INOUT = 'power2.inOut';

  /* ==========================================================================
   * 1) 动态背景：Vanta.js NET —— 成熟开源库（MIT），基于 three.js / GPU 渲染
   *    不用手写着色器：观感稳定、维护成本低。库缺失或无 WebGL 时静默跳过。
   * ======================================================================== */
  var VANTA_EFFECT = 'NET';   /* 换风格只改这里（配套 vendor/vanta/vanta.<name>.min.js + 对应配置） */
  var vanta = null;

  function initVanta() {
    var host = document.getElementById('bgVanta');
    var V = window.VANTA && window.VANTA[VANTA_EFFECT];
    if (!host || !V) return;
    try {
      vanta = V({
        el: host,
        mouseControls: true,
        touchControls: false,
        gyroControls: false,
        minHeight: 200,
        minWidth: 200,
        scale: 0.85,
        scaleMobile: 0.6,
        backgroundColor: 0x06070a,
        color: 0x368fc0,
        points: 8.0,
        maxDistance: 22.0,    /* 与 spacing 接近 -> 连线成网但不糊成一片 */
        spacing: 22.0,        /* 比默认 15 稀 -> 留白更多，不压正文 */
        showDots: true
      });
    } catch (e) {
      console.warn('[bg-vanta] init failed: ' + e.message);
      vanta = null;
    }
  }
  initVanta();

  /* 隐藏页暂停，省电省 GPU */
  document.addEventListener('visibilitychange', function () {
    if (!vanta) return;
    if (document.hidden) { if (vanta.pause) vanta.pause(); }
    else { if (vanta.play) vanta.play(); }
  });
  var vrz = null;
  window.addEventListener('resize', function () {
    clearTimeout(vrz);
    vrz = setTimeout(function () { if (vanta && vanta.resize) vanta.resize(); }, 200);
  }, { passive: true });

  /* ==========================================================================
   * 2) 预加载：计数 + 进度条 → 揭幕
   * ======================================================================== */
  var boot = document.getElementById('boot');
  var bootBar = document.getElementById('bootBar');
  var bootPct = document.getElementById('bootPct');

  function finishBoot(immediate) {
    if (!boot) return;
    if (immediate) { boot.style.display = 'none'; return; }
    boot.style.transition = 'transform .8s cubic-bezier(.4,0,.2,1), opacity .5s';
    boot.style.transform = 'translate3d(0,-100%,0)';
    boot.style.opacity = '0';
    setTimeout(function () { boot.style.display = 'none'; }, 850);
  }

  /* ==========================================================================
   * 3) 主流程
   * ======================================================================== */
  if (!hasGSAP || REDUCE) {
    /* 降级：不做 GSAP 动效，内容照常可见 */
    docEl.classList.add('no-motion');
    finishBoot(true);
    return;
  }

  gsap.registerPlugin(hasST ? ScrollTrigger : window.gsap);
  if (hasSplit) { try { gsap.registerPlugin(SplitText); } catch (e) {} }

  /* 3.1 告知 CSS：动效已就绪（此时才允许隐藏待入场元素） */
  docEl.classList.add('motion-ready');

  /* 3.2 Lenis 平滑滚动 */
  var lenis = null;
  if (typeof window.Lenis !== 'undefined') {
    lenis = new window.Lenis({
      duration: 1.15,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      wheelMultiplier: 0.92,
      touchMultiplier: 1.6
    });
    if (hasST) { lenis.on('scroll', ScrollTrigger.update); }
    gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  /* 3.3 内置锚点改用 Lenis 平滑滚动（避开 html{scroll-behavior:smooth} 冲突） */
  Array.prototype.forEach.call(document.querySelectorAll('a[href^="#"]'), function (a) {
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    var el = document.getElementById(id);
    if (!el) return;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (lenis) lenis.scrollTo(el, { offset: -72, duration: 1.25 });
      else el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  /* 3.4 导航滚动态 */
  if (hasST) {
    ScrollTrigger.create({
      start: 'top -20',
      end: 99999,
      onUpdate: function (self) {
        var nav = document.querySelector('.top-nav');
        if (nav) nav.classList.toggle('scrolled', self.scroll() > 20);
      }
    });
  }

  /* ------------------------------------------------------------------
   * 3.5 预加载 + 首屏揭幕
   *   预加载不依赖字体；字标拆字必须等字体就绪，
   *   否则 SplitText 会告警、且按错误字体度量换行（导致错位）。
   * ---------------------------------------------------------------- */
  function whenFonts(cb) {
    var done = false;
    function go() { if (done) return; done = true; cb(); }
    setTimeout(go, 2000);                                   /* 兜底：最多等 2s */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(go)['catch'](go);
    } else { go(); }
  }

  var prog = { v: 0 };
  gsap.timeline()
    .to(prog, {
      v: 100, duration: 1.5, ease: EASE_INOUT,
      onUpdate: function () {
        var v = Math.round(prog.v);
        if (bootPct) bootPct.textContent = (v < 10 ? '0' : '') + v + '%';
        if (bootBar) bootBar.style.width = v + '%';
      }
    })
    /* 预加载揭幕：交给 GSAP 统一驱动（CSS 过渡不受控） */
    .to(boot || {}, {
      yPercent: -100, duration: 0.85, ease: 'power3.inOut',
      onComplete: function () { if (boot) boot.style.display = 'none'; }
    }, '+=0.1');

  whenFonts(function () {
    var heroChars = [];
    if (hasSplit) {
      var word = document.querySelector('.hero-word');
      if (word) {
        var sp = new SplitText(word, { type: 'chars', charsClass: 'hc' });
        heroChars = sp.chars;
        word.style.perspective = '700px';
        gsap.set(heroChars, { yPercent: 120, opacity: 0, rotateX: -70, transformOrigin: '50% 100%' });
      }
    }
    gsap.timeline({ delay: 0.15 })
      /* 字标：慢入慢出 + 重叠跟进（follow-through） */
      .to(heroChars, {
        yPercent: 0, opacity: 1, rotateX: 0,
        duration: 1.05, ease: 'power4.out', stagger: 0.055
      })
      .from('.hero-kicker', { y: 14, opacity: 0, duration: 0.5, ease: EASE }, '-=0.85')
      .from('.hero .hero-sub', { y: 16, opacity: 0, duration: 0.5, ease: EASE }, '-=0.78')
      .from('.hero .hero-url', { y: 12, opacity: 0, duration: 0.45, ease: EASE }, '-=0.72')
      .from('.hero .cta-row .btn', {
        y: 18, opacity: 0, scale: 0.97, duration: 0.5, ease: 'back.out(1.6)', stagger: 0.09
      }, '-=0.66')
      .from('.hero-top, .hero-foot', { opacity: 0, duration: 0.6, ease: EASE }, '-=0.6')
      .from('.hero-side a', { x: 18, opacity: 0, duration: 0.45, ease: EASE, stagger: 0.07 }, '-=0.5')
      .from('.hud-frame span', { scale: 0, opacity: 0, duration: 0.4, ease: 'back.out(2)', stagger: 0.05 }, '-=0.5');
  });

  /* ------------------------------------------------------------------
   * 3.6 滚动揭示：.reveal 批量入场（staging：先标题后内容）
   * ---------------------------------------------------------------- */
  if (hasST) {
    gsap.set('.reveal', { y: 30, opacity: 0 });
    ScrollTrigger.batch('.reveal', {
      start: 'top 88%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, {
          y: 0, opacity: 1, duration: 0.7, ease: EASE, stagger: 0.07,
          overwrite: true
        });
      }
    });

    /* 章节大编号水印：视差 */
    document.querySelectorAll('.sec-no').forEach(function (el) {
      gsap.fromTo(el, { y: 40 }, {
        y: -50, ease: 'none',
        scrollTrigger: { trigger: el.parentElement, start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });

    /* 区块标题已带 .reveal，由上面的 batch 统一揭示。
       不要再对 .section-title 做 SplitText：① 与 .reveal 重复叠加会互相打架；
       ② 想用 linesClass 做遮罩但 SplitText 不会生成外层包裹元素，
          overflow:hidden 落在行自身上等于无效，行会整体下移错位。 */
  }

  /* ------------------------------------------------------------------
   * 3.7 背景层动效：漂浮光团 + 底色视差
   *     （原手绘 SVG 线稿层已移除，动态部分交给 Vanta NET）
   * ---------------------------------------------------------------- */
  var base = document.querySelector('.bg-base');
  if (!REDUCE) {
    /* 背景漂浮光团（纯 transform，GPU 合成） */
    gsap.utils.toArray('.bg-glow').forEach(function (el, i) {
      gsap.to(el, {
        xPercent: i % 2 ? -18 : 16,
        yPercent: i % 2 ? 14 : -12,
        scale: i % 2 ? 0.88 : 1.22,
        duration: 22 + i * 9,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true
      });
    });
    if (base && hasST) {
      gsap.fromTo(base, { yPercent: 0 }, {
        yPercent: 3, ease: 'none',
        scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: true }
      });
    }
  }

  /* ------------------------------------------------------------------
   * 3.8 微交互：磁吸按钮 + 自定义光标（仅精确指针设备）
   * ---------------------------------------------------------------- */
  if (!COARSE && !REDUCE) {
    /* 磁吸 */
    document.querySelectorAll('.btn, .nav-cta, .hero-side a').forEach(function (el) {
      var qx = gsap.quickTo(el, 'x', { duration: 0.4, ease: 'power3.out' });
      var qy = gsap.quickTo(el, 'y', { duration: 0.4, ease: 'power3.out' });
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        qx((e.clientX - (r.left + r.width / 2)) * 0.22);
        qy((e.clientY - (r.top + r.height / 2)) * 0.28);
      });
      el.addEventListener('mouseleave', function () { qx(0); qy(0); });
    });

    /* 光标环 */
    var cur = document.getElementById('cursor');
    if (cur) {
      var cx = gsap.quickTo(cur, 'x', { duration: 0.35, ease: 'power3.out' });
      var cy = gsap.quickTo(cur, 'y', { duration: 0.35, ease: 'power3.out' });
      window.addEventListener('mousemove', function (e) {
        cur.style.opacity = '1';
        cx(e.clientX); cy(e.clientY);
        var hot = e.target && e.target.closest && e.target.closest('a,button,.card,.hero-side a,input,textarea');
        cur.classList.toggle('hot', !!hot);
      }, { passive: true });
      document.addEventListener('mouseleave', function () { cur.style.opacity = '0'; });
    }
  }

  /* ------------------------------------------------------------------
   * 3.9 收尾：字体/图片就位后刷新滚动量测
   * ---------------------------------------------------------------- */
  window.addEventListener('load', function () {
    if (hasST) ScrollTrigger.refresh();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { if (hasST) ScrollTrigger.refresh(); });
  }
  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (hasST) ScrollTrigger.refresh(); }, 220);
  });
})();
