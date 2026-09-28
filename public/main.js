/* ============================================================================
 * evolve/main.js — mobile sheet menu + stats count-up
 * No framework. Vanilla JS only.
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * Mobile sheet menu
   * ------------------------------------------------------------- */
  var burger = document.getElementById('burger');
  var menu = document.getElementById('mobileMenu');
  var overlay = document.getElementById('overlay');
  var body = document.body;

  function openMenu() {
    if (!menu || !overlay || !burger) return;
    menu.hidden = false;
    overlay.hidden = false;
    body.classList.add('menu-open');
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Close menu');
  }
  function closeMenu() {
    if (!menu || !overlay || !burger) return;
    menu.hidden = true;
    overlay.hidden = true;
    body.classList.remove('menu-open');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open menu');
  }

  if (burger) {
    burger.addEventListener('click', function () {
      if (burger.getAttribute('aria-expanded') === 'true') closeMenu();
      else openMenu();
    });
  }
  if (overlay) overlay.addEventListener('click', closeMenu);
  if (menu) {
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeMenu);
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 720) closeMenu();
  });

  /* ---------------------------------------------------------------
   * Stats count-up
   * ------------------------------------------------------------- */
  var statEls = Array.prototype.slice.call(document.querySelectorAll('.stat'));

  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }

  function runCount(i, statEl) {
    var valEl = statEl.querySelector('.stat-value');
    if (!valEl) return;
    var target = parseFloat(valEl.getAttribute('data-target')) || 0;
    var suffix = valEl.getAttribute('data-suffix') || '';
    var dec = parseInt(valEl.getAttribute('data-decimals') || '0', 10);
    var dur = 1500 + i * 80;
    var delay = 480 + i * 90;

    setTimeout(function () {
      var t0 = performance.now();
      function frame(now) {
        var p = Math.min(1, (now - t0) / dur);
        var v = target * easeOutCubic(p);
        valEl.textContent = v.toFixed(dec) + suffix;
        if (p < 1) requestAnimationFrame(frame);
        else valEl.textContent = target.toFixed(dec) + suffix;
      }
      requestAnimationFrame(frame);
    }, delay);
  }

  if ('IntersectionObserver' in window && statEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          var i = statEls.indexOf(en.target);
          if (i >= 0) runCount(i, en.target);
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.25 });
    statEls.forEach(function (el) { io.observe(el); });
  } else {
    // Fallback: just set final values
    statEls.forEach(function (el, i) { runCount(i, el); });
  }
})();
