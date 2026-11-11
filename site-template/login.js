/* login.html 的页面脚本。
 *
 * 为什么是外部文件而不是内联 `<script>`：发布产物的 CSP 会拦掉内联脚本，
 * 内联等于线上静默不执行（L0 的 `inline_script` 硬项就是这么来的）。
 * 平台注入的 `/_crm/sdk.js` 提供 `window.SiteCrm`，这里只管页面交互。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function flash(kind, text) {
    $('flash').innerHTML = text
      ? '<div class="' + kind + '">' + SiteCrm.escape(text) + '</div>' : '';
  }
  // 只接受站内路径，避免开放重定向
  function next() {
    var n = new URLSearchParams(location.search).get('next');
    if (!n || n.charAt(0) === '/' || /^[a-z]+:/i.test(n)) return 'account.html';
    return n;
  }

  // 分享链接形如 /login?ref=FRIEND-A1B2：预填但**不隐藏**，用户看得见也能改
  var ref = new URLSearchParams(location.search).get('ref');
  if (ref) $('ref').value = ref.trim().toUpperCase();

  $('send').addEventListener('click', function () {
    var email = $('email').value.trim();
    if (!email) { flash('err', '先填邮箱'); return; }
    $('send').disabled = true;
    SiteCrm.sendCode(email).then(function (r) {
      if (r.devCode) {
        $('devcode').hidden = false;
        $('devcode').textContent = '开发环境回显验证码：' + r.devCode;
        $('code').value = r.devCode;
      } else {
        $('devcode').hidden = true;
        flash('ok', '验证码已发送，请查收邮件');
      }
    }).catch(function (e) {
      flash('err', e.message || '发送失败，请稍后再试');
    }).finally(function () {
      $('send').disabled = false;
    });
  });

  $('verify').addEventListener('click', function () {
    var email = $('email').value.trim();
    var code = $('code').value.trim();
    var r = $('ref').value.trim();
    if (!email || !code) { flash('err', '邮箱和验证码都要填'); return; }
    $('verify').disabled = true;
    SiteCrm.verify(email, code, r).then(function () {
      location.assign(next());
    }).catch(function (e) {
      flash('err', e.message || '登录失败，请重试');
    }).finally(function () {
      $('verify').disabled = false;
    });
  });
})();
