/* login.html 的页面脚本。
 *
 * 版式：邮箱一行；验证码与「发送验证码」同一行；「登录」单独一行。
 * 为什么要外部文件而不是内联 `<script>`：内联代码在加 CSP 后会被静默拦掉
 * （L0 的 `inline_script` 硬项就是这么来的）。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var timer = null;

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

  /** 重发倒计时：60 秒内不给点，避免"点十下收十封邮件" */
  function cooldown(seconds) {
    var left = seconds;
    var btn = $('send');
    btn.disabled = true;
    btn.textContent = '重新发送 ' + left + 's';
    clearInterval(timer);
    timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = '重新发送';
        return;
      }
      btn.textContent = '重新发送 ' + left + 's';
    }, 1000);
  }

  function sendCode() {
    var email = $('email').value.trim();
    if (!email) { flash('err', '先填邮箱'); $('email').focus(); return; }
    $('send').disabled = true;
    SiteCrm.sendCode(email).then(function (r) {
      if (r.devCode) {
        $('devcode').hidden = false;
        $('devcode').textContent = '开发环境回显验证码：' + r.devCode;
        $('code').value = r.devCode;
      } else {
        $('devcode').hidden = true;
        flash('ok', '验证码已发到 ' + email);
      }
      $('code').focus();
      cooldown(60);
    }).catch(function (e) {
      $('send').disabled = false;
      flash('err', e.message || '发送失败，请稍后再试');
    });
  }

  function verify() {
    var email = $('email').value.trim();
    var code = $('code').value.trim();
    if (!email) { flash('err', '先填邮箱'); $('email').focus(); return; }
    if (!code) { flash('err', '填一下验证码'); $('code').focus(); return; }
    $('verify').disabled = true;
    SiteCrm.verify(email, code, $('ref').value.trim()).then(function () {
      location.assign(next());
    }).catch(function (e) {
      flash('err', e.message || '登录失败，请重试');
    }).finally(function () {
      $('verify').disabled = false;
    });
  }

  // 分享链接形如 /login?ref=FRIEND-A1B2：预填但**不隐藏**，用户看得见也能改
  var ref = new URLSearchParams(location.search).get('ref');
  if (ref) $('ref').value = ref.trim().toUpperCase();

  $('send').addEventListener('click', sendCode);
  $('verify').addEventListener('click', verify);

  $('email').addEventListener('keydown', function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); if (!$('send').disabled) sendCode(); }
  });
  $('code').addEventListener('keydown', function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); verify(); }
  });
})();
