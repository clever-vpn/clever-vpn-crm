/* 全站共用的小脚本：移动端菜单（抽屉）。
 *
 * 为什么是外部文件而不是内联 `<script>`：内联代码在加 CSP 后会被静默拦掉
 * （L0 的 `inline_script` 硬项就是这么来的）。
 *
 * 行为按"标准移动菜单"来：
 *   · 点汉堡 → 抽屉从顶部滑下、遮罩、锁住页面滚动；
 *   · 点 ×、点遮罩、按 Esc、点任意链接 → 关闭；
 *   · 宽屏（>720）下按钮隐藏，抽屉永不出现（CSS 兜底）。
 */
(function () {
  var btn = document.querySelector('.menu-btn');
  var drawer = document.getElementById('site-menu');
  if (!btn || !drawer) return;

  var closeBtn = drawer.querySelector('.drawer-close');

  function open() {
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-open');
    if (closeBtn) closeBtn.focus();
  }
  function close() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
  }
  function toggle() {
    if (drawer.classList.contains('open')) close(); else open();
  }

  btn.addEventListener('click', toggle);
  if (closeBtn) closeBtn.addEventListener('click', close);
  drawer.addEventListener('click', function (ev) {
    // 点遮罩（抽屉背景）关闭；点链接本身会导航，也顺手关掉
    if (ev.target === drawer) close();
  });
  Array.prototype.forEach.call(drawer.querySelectorAll('a'), function (a) {
    a.addEventListener('click', close);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') close();
  });
  // 转屏 / 放大到桌面宽度时把状态收干净
  window.addEventListener('resize', function () {
    if (window.innerWidth > 720) close();
  });
})();
