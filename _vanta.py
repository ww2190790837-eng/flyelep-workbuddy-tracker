#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「手绘 SVG 线稿 + 自写噪声着色器」背景换成成熟的 Vanta.js NET。
   index.html：删 .bg-draw / .gl-canvas，加 #bgVanta + 库 script
   motion.js：删 initGL，换成 initVanta；清理 .bg-draw 相关动效"""
import io

def sub(s, old, new, label):
    assert old in s, "NOT FOUND: " + label
    return s.replace(old, new, 1)

# ============================ index.html ============================
P = "public/index.html"
s = io.open(P, encoding="utf-8").read()
n0 = len(s)

# 1) .bg-draw CSS 块 -> #bgVanta 样式
s = sub(s,
"""  .bg-draw{position:absolute;inset:-12% -8%;opacity:.42;transform:translate3d(0,0,0);will-change:transform;
    animation:drawDrift 140s ease-in-out infinite}
  .bg-draw svg{width:100%;height:100%;display:block}
  @keyframes drawDrift{
    0%,100%{transform:translate3d(0,0,0) scale(1.02) rotate(0deg)}
    50%{transform:translate3d(-1.6%,-1.2%,0) scale(1.05) rotate(.5deg)}
  }
""",
"""  /* 动态网络层：Vanta.js NET（three.js / GPU 渲染） */
  #bgVanta{position:absolute;inset:0;z-index:1}
  #bgVanta canvas{display:block}
""", "bg-draw CSS")

# 2) 亮色主题里的 .bg-draw
s = sub(s, '  [data-theme="light"] .bg-draw{opacity:.5}\n', "", "light bg-draw")

# 3) 第 9 段里的 .bg-draw
s = sub(s, '  .bg-draw{animation:none}   /* 线稿漂移改由 GSAP 驱动（漂移 + 鼠标视差 + 滚动视差） */\n', "", "section9 bg-draw")

# 4) .gl-canvas CSS
s = sub(s,
"""  .gl-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:3;
    mix-blend-mode:screen;pointer-events:none;opacity:.85}
""", "", "gl-canvas CSS")

# 5) 删除 .bg-draw 的整段 SVG
i = s.find('  <div class="bg-draw">')
assert i >= 0, "NOT FOUND: bg-draw markup"
endmark = "    </svg>\n  </div>\n"
j = s.find(endmark, i)
assert j > i, "NOT FOUND: bg-draw end"
j += len(endmark)
s = s[:i] + s[j:]

# 6) canvas -> #bgVanta
s = sub(s,
'  <canvas class="gl-canvas" id="glCanvas" aria-hidden="true"></canvas>',
'  <div id="bgVanta"></div>', "canvas->vanta host")

# 7) 背景注释
s = sub(s,
"""<!-- 全站统一背景：静态渐变 + 缓慢漂移线稿(纯 SVG) + 网格 + 扫描线 + 暗角 + 噪点
     全部只用 transform/opacity 合成，无 canvas 逐帧重绘、无大面积 blur。 -->""",
"""<!-- 全站统一背景：静态渐变 + 漂浮光团 + Vanta.js NET 动态网络层 + 网格 + 扫描线 + 暗角 + 噪点
     动态层走 three.js/GPU；其余层只用 transform/opacity 合成，避免逐帧重绘大范围渐变。 -->""",
"bg comment")

# 8) 网格淡一点，避免和 NET 抢
s = sub(s, "  .bg-grid{position:absolute;inset:0;opacity:.14;",
           "  .bg-grid{position:absolute;inset:0;opacity:.10;", "grid opacity")

# 9) 引入 three + vanta
s = sub(s,
'<script src="/vendor/lenis.min.js"></script>\n<script src="/motion.js"></script>',
'<script src="/vendor/lenis.min.js"></script>\n'
'<script src="/vendor/three.min.js"></script>\n'
'<script src="/vendor/vanta/vanta.net.min.js"></script>\n'
'<script src="/motion.js"></script>', "script tags")

io.open(P, "w", encoding="utf-8").write(s)
print("index.html: %d -> %d" % (n0, len(s)))

# ============================ motion.js ============================
M = "public/motion.js"
m = io.open(M, encoding="utf-8").read()
m0 = len(m)

NEW1 = '''  /* ==========================================================================
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
        backgroundColor: 0x07080a,
        color: 0x2f89c0,
        points: 9.0,
        maxDistance: 24.0,
        spacing: 19.0,
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
'''

i = m.find("  /* ==========================================================================\n   * 1) WebGL 颗粒层")
assert i >= 0, "NOT FOUND: section 1 start"
j = m.find("  initGL();\n", i)
assert j > i, "NOT FOUND: initGL() call"
j += len("  initGL();\n")
m = m[:i] + NEW1 + m[j:]

NEW37 = '''  /* ------------------------------------------------------------------
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
'''

i = m.find("  /* ------------------------------------------------------------------\n   * 3.7 背景层动效")
assert i >= 0, "NOT FOUND: section 3.7 start"
j = m.find("  /* ------------------------------------------------------------------\n   * 3.8 微交互", i)
assert j > i, "NOT FOUND: section 3.8 start"
m = m[:i] + NEW37 + "\n" + m[j:]

io.open(M, "w", encoding="utf-8").write(m)
print("motion.js: %d -> %d" % (m0, len(m)))

# 残留自检
for kw in ["initGL", "bg-draw", "gl-canvas", "glCanvas", "drawDrift", "bg-draw svg"]:
    left = m.count(kw)
    print("  motion.js 残留 %-12s = %d" % (kw, left))
