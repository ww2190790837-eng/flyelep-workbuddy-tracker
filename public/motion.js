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
   * 1) 背景层：静态 CSS 层（渐变 + 光团 + 网格 + 扫描线 + 噪点 + 暗角）。
   *    已移除 Vanta/three.js —— 与主视觉重复且空转 WebGL 明显拖慢页面。
   * ======================================================================== */

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

  /* P3 式揭幕（对齐官方 p3_circle 参考帧）：靛蓝底上三圈天蓝同心环交错向外扩散，
     再由「中心开孔」（--p3hole 0%→180%）把首屏让出来。
     动画全部交给 CSS（环走 transform=GPU，孔走 @property 变量），
     JS 只加/去 .play 做兜底清理 —— 不逐帧写样式，避免主线程卡顿。 */
  var wipe = document.getElementById('wipe');
  function startWipe() {
    if (!wipe) return;
    /* 调试开关：URL 带 ?nowipe=1 可跳过揭幕（排查用） */
    if (location.search.indexOf('nowipe') >= 0) return;
    /* 尊重系统「减弱动态效果」：直接跳过，不硬放动画 */
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var done = false;
    function finish() {
      if (done) return; done = true;
      wipe.classList.remove('play');
      wipe.style.display = 'none';
    }
    wipe.classList.remove('play');
    wipe.style.display = 'block';
    void wipe.offsetWidth;                 /* 强制重排，确保动画从头播放 */
    wipe.classList.add('play');
    /* 硬性兜底：无论动画是否如期跑完，都不允许揭幕层一直盖住页面 */
    setTimeout(finish, 1900);
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
    .call(startWipe, null, '+=0.1')
    /* 预加载揭幕：交给 GSAP 统一驱动（CSS 过渡不受控） */
    .to(boot || {}, {
      yPercent: -100, duration: 0.85, ease: 'power3.inOut',
      onComplete: function () { if (boot) boot.style.display = 'none'; }
    }, '+=0.05');

  whenFonts(function () {
    var word = document.querySelector('.hero-word');
    if (!word) return;                 /* 仅首页有 hero 入场，子页（无 .hero-word）直接跳过 */
    var heroChars = [];
    if (hasSplit) {
      var sp = new SplitText(word, { type: 'chars', charsClass: 'hc' });
      heroChars = sp.chars;
      word.style.perspective = '700px';
      gsap.set(heroChars, { yPercent: 120, opacity: 0, rotateX: -70, transformOrigin: '50% 100%' });
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
   * 3.7 连贯背景视差：多层以不同速率随滚动分层位移，制造贯穿全站的纵深镜头感
   *     全部 scroll-driven（scrub，transform-only，不动 layout）；
   *     移除旧的发光体自动漂浮，尊重「性能预算 / 少自动飘动」纪律。
   * ---------------------------------------------------------------- */
  if (hasST && !REDUCE) {
    /* 每层给一对 (y,x) 半幅位移：正负决定方向，大小决定纵深快慢。
       近景(bg-page)慢、远景(bg-deep)反向更快，叠出"镜头穿过空间"的连贯感。 */
    var parallaxLayers = [
      { sel: '.bg-base',    y: 3,   x: 0 },
      { sel: '.bg-deep',    y: -13, x: 0 },
      { sel: '.bg-page',    y: 7,   x: 0 },
      { sel: '.bg-grid',    y: 5,   x: -5 },
      { sel: '.bg-glow.g1', y: -16, x: 0 },
      { sel: '.bg-glow.g2', y: 14,  x: 0 }
    ];
    parallaxLayers.forEach(function (L) {
      gsap.utils.toArray(L.sel).forEach(function (el) {
        gsap.fromTo(el,
          { yPercent: -L.y, xPercent: -L.x },
          { yPercent: L.y, xPercent: L.x, ease: 'none',
            scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: true } });
      });
    });

    /* 3.7b 叙事脊柱：节点沿左侧轨道随滚动进度下移，把各章节串成一条连续镜头轨 */
    var spine = document.querySelector('.scroll-spine');
    var spNode = document.getElementById('spNode');
    if (spine && spNode) {
      ScrollTrigger.create({
        trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: true,
        onUpdate: function (self) {
          var h = spine.clientHeight - spNode.offsetHeight;
          spNode.style.top = (self.progress * Math.max(0, h)) + 'px';
        }
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
  /* ------------------------------------------------------------------
   * 3.10 Hero / 章节美术 视差（滚动驱动，纯 transform / GPU 合成）
   * ------------------------------------------------------------------ */
  if (hasST && !REDUCE) {
    /* 首屏美术的视差已交给 3.12 的 pinned zoom-through，这里不再重复驱动 .hero-art */
    gsap.utils.toArray('.sec-art').forEach(function (el) {
      var img = el.querySelector('img') || el;
      gsap.fromTo(img, { yPercent: -10 }, {
        yPercent: 12, ease: 'none',
        scrollTrigger: { trigger: el.closest('section') || el, start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });
  }

  /* ------------------------------------------------------------------
   * 3.11 卡片 3D 倾斜微交互（仅精确指针、非降级；作用于无 transform 过渡的大卡）
   * ------------------------------------------------------------------ */
  if (!COARSE && !REDUCE && hasGSAP) {
    document.querySelectorAll('.pg-card, .vu-card, .cap-card').forEach(function (card) {
      gsap.set(card, { transformPerspective: 900, transformOrigin: 'center' });
      var rx = gsap.quickTo(card, 'rotationX', { duration: 0.5, ease: 'power3.out' });
      var ry = gsap.quickTo(card, 'rotationY', { duration: 0.5, ease: 'power3.out' });
      var sc = gsap.quickTo(card, 'scale', { duration: 0.5, ease: 'power3.out' });
      card.style.willChange = 'transform';
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        ry(px * 12); rx(-py * 12); sc(1.015);
      });
      card.addEventListener('mouseleave', function () { rx(0); ry(0); sc(1); });
    });
  }

  /* ------------------------------------------------------------------
   * 3.12 Hero 沉浸式缩放穿过（pinned zoom-through）
   *    首屏固定，向下滚动时背景美术放大、前景文字推向镜头并淡出模糊，
   *    制造「俯冲进入」的纵深感。仅在精确指针、非降级时启用。
   * ------------------------------------------------------------------ */
  var heroSec = document.getElementById('heroSection');
  if (heroSec && hasST && !COARSE && !REDUCE) {
    var heroArt = heroSec.querySelector('.hero-art');
    var heroInner = heroSec.querySelector('.hero-inner');
    var hudFrame = heroSec.querySelector('.hud-frame');
    var heroScan = heroSec.querySelector('.hero-scan');
    if (heroArt) gsap.set(heroArt, { filter: 'brightness(1) saturate(1)' });
    if (heroInner) gsap.set(heroInner, { filter: 'blur(0px)' });
    if (heroScan) gsap.set(heroScan, { top: '0%' });
    var htl = gsap.timeline({
      scrollTrigger: {
        trigger: heroSec,
        start: 'top top',
        end: '+=130%',
        pin: true,
        scrub: true,
        anticipatePin: 1
      }
    });
    if (heroArt) htl.to(heroArt, { scale: 1.4, filter: 'brightness(1.4) saturate(1.2)', ease: 'none' }, 0);
    if (heroInner) htl.to(heroInner, { scale: 1.3, autoAlpha: 0, filter: 'blur(14px)', ease: 'none' }, 0);
    if (hudFrame) htl.to(hudFrame, { autoAlpha: 0, scale: 1.12, ease: 'none' }, 0);
    if (heroScan) htl.to(heroScan, { top: '100%', ease: 'none' }, 0);
  }

  /* ------------------------------------------------------------------
   * 3.13 核心能力：pinned 横向画廊（containerAnimation）
   * ------------------------------------------------------------------ */
  var capSec = document.getElementById('capabilities');
  if (capSec && hasST && !COARSE && !REDUCE) {
    var capTrack = document.getElementById('capTrack');
    if (capTrack) {
      var getDist = function () { return Math.max(0, capTrack.scrollWidth - window.innerWidth); };
      var capTween = gsap.to(capTrack, {
        x: function () { return -getDist(); },
        ease: 'none',
        scrollTrigger: {
          trigger: capSec,
          start: 'top top',
          end: function () { return '+=' + getDist(); },
          pin: true,
          scrub: 1,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate: function (self) {
            var f = document.getElementById('capRailFill');
            if (f) f.style.width = (self.progress * 100).toFixed(1) + '%';
            var tg = document.getElementById('capRailTag');
            if (tg) tg.textContent = 'SCROLL ' + (self.progress * 100).toFixed(0) + '%';
            var idx = document.getElementById('capRailIdx');
            if (idx) {
              var n = Math.min(6, 1 + Math.floor(self.progress * 6));
              idx.textContent = ('0' + n).slice(-2) + ' / 06';
            }
          }
        }
      });
      gsap.utils.toArray('.cap-card').forEach(function (card) {
        gsap.from(card, {
          y: 70, opacity: 0, duration: 0.9, ease: 'power3.out',
          scrollTrigger: { trigger: card, containerAnimation: capTween, start: 'left 88%' }
        });
      });
    }
  }

  /* ------------------------------------------------------------------
   * 3.14 宣言式逐行揭示（SplitText mask）
   * ------------------------------------------------------------------ */
  var manifestoText = document.getElementById('manifestoText');
  if (manifestoText && hasSplit && hasST && !REDUCE) {
    try {
      var mSplit = SplitText.create(manifestoText, { type: 'lines', mask: 'lines', linesClass: 'ml' });
      gsap.set(mSplit.lines, { yPercent: 115 });
      gsap.to(mSplit.lines, {
        yPercent: 0, duration: 1.05, ease: 'power4.out', stagger: 0.12,
        scrollTrigger: { trigger: manifestoText, start: 'top 80%' }
      });
    } catch (e) {}
  }

  /* ------------------------------------------------------------------
   * 3.15 滚动速度响应跑马灯（velocity → 速度 + 倾斜，自动回弹）
   * ------------------------------------------------------------------ */
  var kmTrack = document.getElementById('kmTrack');
  if (kmTrack && hasST && !REDUCE) {
    if (!kmTrack.dataset.dup) { kmTrack.innerHTML += kmTrack.innerHTML; kmTrack.dataset.dup = '1'; }
    var kmLoop = gsap.to(kmTrack, { xPercent: -50, duration: 26, ease: 'none', repeat: -1 });
    var kmSkew = gsap.quickTo(kmTrack, 'skewX', { duration: 0.5, ease: 'power3.out' });
    var kmSkewTarget = 0, kmTsTarget = 1;
    var kmReadout = document.getElementById('kmReadout');
    ScrollTrigger.create({
      onUpdate: function (self) {
        var v = self.getVelocity();
        kmSkewTarget = gsap.utils.clamp(-16, 16, v / 240);
        kmTsTarget = 1 + Math.min(8, Math.abs(v) / 160);
      }
    });
    gsap.ticker.add(function () {
      kmSkewTarget += (0 - kmSkewTarget) * 0.1;
      kmTsTarget += (1 - kmTsTarget) * 0.08;
      kmSkew(kmSkewTarget);
      kmLoop.timeScale(kmTsTarget);
      if (kmReadout) kmReadout.textContent = 'STREAM x' + kmTsTarget.toFixed(1);
    });
  }

  /* ------------------------------------------------------------------
   * 3.16 子页标题逐行揭示（.page-ttl，mask）
   * ------------------------------------------------------------------ */
  if (hasSplit && hasST && !REDUCE) {
    gsap.utils.toArray('.page-ttl').forEach(function (t) {
      try {
        var s = SplitText.create(t, { type: 'lines', mask: 'lines', linesClass: 'ptl' });
        gsap.set(s.lines, { yPercent: 115 });
        gsap.to(s.lines, {
          yPercent: 0, duration: 0.9, ease: 'power4.out', stagger: 0.1,
          scrollTrigger: { trigger: t, start: 'top 85%' }
        });
      } catch (e) {}
    });
  }

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (hasST) ScrollTrigger.refresh(); }, 220);
  });
})();
