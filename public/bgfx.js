/* ============================================================================
 * bgfx.js — 全站 WebGL 流光签名背景
 * 品牌色：深靛 #063a9e → 亮青 #16CFFB → 冰蓝 #7DE6FD
 * 原理：全屏三角形 + 片元着色器（域扭曲 FBM 极光流），纯 GPU 合成，
 *       不参与布局/绘制，零重排零重绘 → 不卡滚动、不影响首屏。
 *
 * 性能与可用性契约：
 *   - DPR 上限 1.5（高分屏不爆像素填充）
 *   - 隐藏标签页（visibilitychange）暂停 rAF
 *   - prefers-reduced-motion：只渲染一帧静态画面，不跑循环
 *   - WebGL 不可用：canvas 隐藏，露出底层 .bg-base 渐变兜底（页面照常可用）
 *   - 鼠标轻微交互（u_mouse）让流光随指针偏移，离开窗口归位
 * ==========================================================================*/
(function () {
  'use strict';

  var canvas = document.getElementById('bgfx');
  if (!canvas) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var gl = null;
  try {
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power' }) ||
          canvas.getContext('experimental-webgl');
  } catch (e) { gl = null; }
  if (!gl) { canvas.style.display = 'none'; return; } // 兜底：露出 .bg-base

  // ---- 着色器 ----
  var VERT = [
    'attribute vec2 a_pos;',
    'void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'uniform vec2 u_res;',
    'uniform float u_time;',
    'uniform vec2 u_mouse;',
    'float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }',
    'float noise(vec2 p){',
    '  vec2 i=floor(p), f=fract(p);',
    '  float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));',
    '  vec2 u=f*f*(3.0-2.0*f);',
    '  return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;',
    '}',
    'float fbm(vec2 p){',
    '  float v=0.0, a=0.5;',
    '  for(int i=0;i<6;i++){ v+=a*noise(p); p*=1.92; a*=0.5; }',
    '  return v;',
    '}',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_res.xy;',
    '  vec2 p = uv; p.x *= u_res.x / u_res.y;',
    '  float t = u_time * 0.045;',
    '  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));',
    '  vec2 r = vec2(fbm(p + 4.0*q + vec2(1.7, 9.2) + 0.15*t),',
    '               fbm(p + 4.0*q + vec2(8.3, 2.8) - 0.12*t));',
    '  float f = fbm(p + 4.0*r);',
    '  vec2 m = u_mouse * 0.16;',
    '  f += 0.07 * sin((p.x + m.x) * 3.0 + t * 2.0) * cos((p.y + m.y) * 3.0 - t * 1.5);',
    '  vec3 deep = vec3(0.024, 0.227, 0.620);', // #063a9e
    '  vec3 mid  = vec3(0.063, 0.294, 0.741);', // #0a4bbd
    '  vec3 cyan = vec3(0.086, 0.812, 0.984);', // #16CFFB
    '  vec3 ice  = vec3(0.490, 0.902, 0.992);', // #7DE6FD
    '  vec3 col = mix(deep, mid, clamp(f * 1.2, 0.0, 1.0));',
    '  col = mix(col, cyan, clamp(pow(f, 2.0) * 1.4, 0.0, 1.0));',
    '  col = mix(col, ice, clamp(pow(r.x, 3.0) * 0.55, 0.0, 1.0));',
    '  float vig = smoothstep(1.3, 0.25, length(uv - 0.5));',
    '  col *= mix(0.62, 1.0, vig);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      try { console.warn('[bgfx] shader compile failed:', gl.getShaderInfoLog(s)); } catch (e) {}
      return null;
    }
    return s;
  }

  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.style.display = 'none'; return; }

  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.style.display = 'none'; return; }
  gl.useProgram(prog);

  // 全屏三角形（覆盖整个裁剪空间，比 quad 少一个顶点）
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'u_res');
  var uTime = gl.getUniformLocation(prog, 'u_time');
  var uMouse = gl.getUniformLocation(prog, 'u_mouse');

  var DPR_CAP = 1.5;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = Math.max(1, Math.floor(window.innerWidth * dpr));
    var h = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, w, h);
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  // 鼠标交互（平滑跟随）
  var mx = 0, my = 0, tmx = 0, tmy = 0;
  if (!reduce) {
    window.addEventListener('mousemove', function (e) {
      tmx = (e.clientX / window.innerWidth) * 2 - 1;
      tmy = -((e.clientY / window.innerHeight) * 2 - 1);
    }, { passive: true });
    window.addEventListener('mouseleave', function () { tmx = 0; tmy = 0; });
  }

  var start = performance.now();
  var running = true;
  var rafId = 0;

  function render(now) {
    if (reduce) {
      // 只渲染一帧静态画面
      gl.uniform1f(uTime, 12.0);
      gl.uniform2f(uMouse, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }
    var t = (now - start) / 1000;
    mx += (tmx - mx) * 0.04;
    my += (tmy - my) * 0.04;
    gl.uniform1f(uTime, t);
    gl.uniform2f(uMouse, mx, my);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (running) rafId = requestAnimationFrame(render);
  }

  function startLoop() {
    if (reduce || running) return;
    running = true;
    rafId = requestAnimationFrame(render);
  }
  function stopLoop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // 隐藏标签页暂停（省电、避免后台空转）
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop(); else startLoop();
  });

  if (reduce) {
    // 静态一帧
    render(performance.now());
  } else {
    startLoop();
  }
})();
