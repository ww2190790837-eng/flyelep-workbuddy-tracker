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
   * 1) WebGL 颗粒层（独立于 GSAP，最先启动；无 WebGL 则静默退出）
   * ======================================================================== */
  function initGL() {
    var canvas = document.getElementById('glCanvas');
    if (!canvas) return;
    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
          || canvas.getContext('experimental-webgl');
    if (!gl) { canvas.style.display = 'none'; return; }

    var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    var FS = [
      'precision mediump float;',
      'uniform vec2 uRes;uniform float uTime;uniform vec2 uMouse;uniform float uScroll;',
      'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}',
      'void main(){',
      '  vec2 uv=gl_FragCoord.xy/uRes.xy;',
      '  vec2 q=(gl_FragCoord.xy-0.5*uRes.xy)/uRes.y;',
      '  float t=uTime;',
      // 细网格
      '  vec2 gu=uv*vec2(uRes.x/uRes.y,1.0)*26.0;',
      '  vec2 gw=abs(fract(gu)-0.5);',
      '  float grid=max(smoothstep(0.497,0.5,gw.x),smoothstep(0.497,0.5,gw.y));',
      // 扫描线（缓慢下移）
      '  float scan=0.5+0.5*sin((gl_FragCoord.y*0.9+t*26.0));',
      // 横向扫光（缓慢划过）
      '  float sx=fract(t*0.035);',
      '  float sweep=exp(-pow((uv.x-sx)*7.0,2.0));',
      '  float sweep2=exp(-pow((uv.x-fract(t*0.035+0.5))*11.0,2.0))*0.5;',
      // 鼠标补光
      '  vec2 mo=vec2(uMouse.x,uMouse.y);',
      '  float halo=exp(-pow(length((uv-mo)*vec2(uRes.x/uRes.y,1.0))*2.6,2.0))*0.5;',
      // 颗粒
      '  float n=hash(gl_FragCoord.xy*0.7+fract(t)*vec2(37.0,17.0));',
      // 暗角 + 滚动呼吸
      '  float vig=smoothstep(1.25+uScroll*0.06,0.22,length(q*vec2(1.0,1.12)));',
      '  vec3 col=vec3(0.0);',
      '  col+=vec3(0.60,0.73,0.87)*grid*0.03;',
      '  col+=vec3(0.52,0.66,0.80)*scan*0.010;',
      '  col+=vec3(0.70,0.82,0.96)*(sweep+sweep2)*0.028;',
      '  col+=vec3(0.66,0.80,0.96)*halo*0.05;',
      '  col+=vec3(n)*0.026;',
      '  col*=vig;',
      '  gl_FragColor=vec4(col,1.0);',
      '}'
    ].join('\n');

    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { return null; }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) { canvas.style.display = 'none'; return; }
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.style.display = 'none'; return; }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    var uRes = gl.getUniformLocation(prog, 'uRes');
    var uTime = gl.getUniformLocation(prog, 'uTime');
    var uMouse = gl.getUniformLocation(prog, 'uMouse');
    var uScroll = gl.getUniformLocation(prog, 'uScroll');

    var DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    var W = 0, H = 0;
    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(W * DPR));
      canvas.height = Math.max(1, Math.floor(H * DPR));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
    }
    resize();

    var rz = null;
    window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(resize, 180); }, { passive: true });

    var mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5;
    if (!COARSE) {
      window.addEventListener('mousemove', function (e) {
        tx = e.clientX / window.innerWidth; ty = 1 - e.clientY / window.innerHeight;
      }, { passive: true });
    }

    var t0 = performance.now(), frame = 0, raf = null;
    function draw(now) {
      raf = requestAnimationFrame(draw);
      frame++;
      if (frame % 2) return;                       /* 颗粒层约 30fps 足够，省一半 GPU */
      if (document.hidden) return;
      mx += (tx - mx) * 0.06; my += (ty - my) * 0.06;
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.uniform2f(uMouse, mx, my);
      gl.uniform1f(uScroll, Math.min((window.scrollY || 0) / Math.max(1, window.innerHeight), 3));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (REDUCE) {
      gl.uniform1f(uTime, 3.0);
      gl.uniform2f(uMouse, 0.7, 0.4);
      gl.uniform1f(uScroll, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      raf = requestAnimationFrame(draw);
    }
  }

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
   * 3.5 首屏揭幕时间轴（预加载 → 字标拆字 → 其余元素跟进）
   * ---------------------------------------------------------------- */
  var heroChars = null;
  if (hasSplit) {
    var word = document.querySelector('.hero-word');
    if (word) {
      var sp = new SplitText(word, { type: 'chars', charsClass: 'hc' });
      heroChars = sp.chars;
      /* 让拆出的字走 3D 入场 */
      word.style.perspective = '700px';
      gsap.set(heroChars, { yPercent: 120, opacity: 0, rotateX: -70, transformOrigin: '50% 100%' });
    }
  }

  var bootTl = gsap.timeline();
  var prog = { v: 0 };

  bootTl
    .to(prog, {
      v: 100, duration: 1.5, ease: EASE_INOUT,
      onUpdate: function () {
        var v = Math.round(prog.v);
        if (bootPct) bootPct.textContent = (v < 10 ? '0' : '') + v + '%';
        if (bootBar) bootBar.style.width = v + '%';
      }
    })
    /* 预加载揭幕：交给 GSAP 统一驱动（与其余动效同一时钟，避免 CSS 过渡不可控） */
    .to(boot || {}, {
      yPercent: -100, duration: 0.85, ease: 'power3.inOut',
      onComplete: function () { if (boot) boot.style.display = 'none'; }
    }, '+=0.1')
    /* 字标：慢入慢出 + 重叠跟进（follow-through） */
    .to(heroChars || [], {
      yPercent: 0, opacity: 1, rotateX: 0,
      duration: 1.05, ease: 'power4.out', stagger: 0.055
    }, '-=0.45')
    .from('.hero-kicker', { y: 14, opacity: 0, duration: 0.5, ease: EASE }, '-=0.85')
    .from('.hero .hero-sub', { y: 16, opacity: 0, duration: 0.5, ease: EASE }, '-=0.78')
    .from('.hero .hero-url', { y: 12, opacity: 0, duration: 0.45, ease: EASE }, '-=0.72')
    .from('.hero .cta-row .btn', {
      y: 18, opacity: 0, scale: 0.97, duration: 0.5, ease: 'back.out(1.6)', stagger: 0.09
    }, '-=0.66')
    .from('.hero-top, .hero-foot', { opacity: 0, duration: 0.6, ease: EASE }, '-=0.6')
    .from('.hero-side a', { x: 18, opacity: 0, duration: 0.45, ease: EASE, stagger: 0.07 }, '-=0.5')
    .from('.hud-frame span', { scale: 0, opacity: 0, duration: 0.4, ease: 'back.out(2)', stagger: 0.05 }, '-=0.5');

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

    /* 区块标题：逐行遮罩揭幕（SplitText lines） */
    if (hasSplit) {
      document.querySelectorAll('.section-title').forEach(function (el) {
        var host = el.parentElement;
        var split = new SplitText(el, { type: 'lines', linesClass: 'mask' });
        gsap.set(split.lines, { yPercent: 110, opacity: 0 });
        gsap.to(split.lines, {
          yPercent: 0, opacity: 1, duration: 0.8, ease: 'power4.out', stagger: 0.08,
          scrollTrigger: { trigger: host, start: 'top 85%', once: true }
        });
      });
    }
  }

  /* ------------------------------------------------------------------
   * 3.7 背景层动效：漂移 + 鼠标视差 + 滚动视差
   * ---------------------------------------------------------------- */
  var drawSvg = document.querySelector('.bg-draw svg');
  var base = document.querySelector('.bg-base');
  if (!REDUCE) {
    /* 线稿层缓慢漂移（长时间、不可察觉的位移，制造「活着」的感觉） */
    var draw = document.querySelector('.bg-draw');
    if (draw) {
      gsap.to(draw, {
        x: '-1.4%', y: '-1%', scale: 1.04, rotate: 0.4,
        duration: 34, ease: 'sine.inOut', repeat: -1, yoyo: true
      });
    }
    if (drawSvg) {
      gsap.set(drawSvg, { willChange: 'transform' });
      var qx = gsap.quickTo(drawSvg, 'x', { duration: 1.1, ease: 'power2.out' });
      var qy = gsap.quickTo(drawSvg, 'y', { duration: 1.1, ease: 'power2.out' });
      if (!COARSE) {
        window.addEventListener('mousemove', function (e) {
          qx(((e.clientX / window.innerWidth) - 0.5) * -26);
          qy(((e.clientY / window.innerHeight) - 0.5) * -18);
        }, { passive: true });
      }
      if (hasST) {
        gsap.fromTo(drawSvg, { yPercent: 0 }, {
          yPercent: 4, ease: 'none',
          scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: true }
        });
      }
    }
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
