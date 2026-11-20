/* pricing.html 的页面脚本。
 *
 * 为什么是外部文件而不是内联 `<script>`：发布产物的 CSP 会拦掉内联脚本，
 * 内联等于线上静默不执行（L0 的 `inline_script` 硬项就是这么来的）。
 * 平台注入的 `/_crm/sdk.js` 提供 `window.SiteCrm`，这里只管页面交互。
 */
// 本页只做三件事：拿套餐 / 画卡片 / 处理点击。
// 价格、划线价、角标、按钮文案、能不能买 —— 全部由 SDK 给，页面不判断。
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var KIND = { period: '按时长', traffic: '按流量', addon: '加量包', trial: '免费试用' };
  /** 套餐 id → 视图：点「购买」时要拿到这一档的 method_options */
  var ALL = {};
  function flash(kind, text) {
    $('flash').innerHTML = text
      ? '<div class="' + kind + '">' + SiteCrm.escape(text) + '</div>' : '';
  }

  function card(p) {
    var el = document.createElement('div');
    el.className = 'plan' + (p.compareAt ? ' hot' : '');
    var specs = p.specs.map(function (s) {
      return '<li>' + SiteCrm.escape(s) + '</li>';
    }).join('');
    // 未登录时后端不给 payment_methods，但"要不要先登录"是另一回事：
    // 直接把按钮指向登录，别让人点完才被告知"这一档买不了"。
    var needLogin = p.action === 'login_required';
    // 能付的方式多于一种 ⇒ 点按钮先出选择，不能替用户挑（点了微信付成支付宝
    // 是最糟糕的体验）
    var multi = !needLogin && (p.method_options || []).length > 1;
    // `data-plan-cta` 是闸门的判据之一（每张价格卡都要有一个可点的 CTA）：
    // 这个按钮**就是**那张卡的 CTA，标上它，L0 才能验证"卡和按钮一一对应"。
    var cta = p.buyable
      ? '<button class="btn" type="button" data-plan="' + SiteCrm.escape(p.id) + '"'
          + ' data-plan-cta="1"'
          + (needLogin ? ' data-login="1"' : '')
          + (multi ? ' data-pick="1"' : '') + '>'
          + SiteCrm.escape(p.cta) + '</button>'
      : '<button class="ghost" type="button" disabled>' + SiteCrm.escape(p.cta) + '</button>';
    // 支持的支付方式必须先摆在按钮旁边：用户点之前就要知道能用什么付。
    var pay = (p.methods && p.methods.length)
      ? '<div class="pay-with">支持 ' + SiteCrm.escape(p.methods.join(' / ')) + '</div>'
      : '';
    el.innerHTML =
      '<div class="row" style="justify-content:space-between;align-items:flex-start">'
      + '<div><p class="plan-name">' + SiteCrm.escape(p.name) + '</p>'
      + '<span class="tag">' + SiteCrm.escape(KIND[p.kind] || p.kind) + '</span></div>'
      + (p.badge ? '<span class="badge">' + SiteCrm.escape(p.badge) + '</span>' : '')
      + '</div>'
      + '<div class="amount"><span class="now">' + SiteCrm.escape(p.price) + '</span>'
      + (p.compareAt ? '<span class="was">' + SiteCrm.escape(p.compareAt) + '</span>' : '')
      + '</div>'
      + '<div class="per">' + (p.action === 'renewal' ? '续订价' : '实付价格') + '</div>'
      + '<ul class="spec">' + specs + '</ul>'
      + '<div class="plan-cta">' + pay + cta
      + (!p.buyable && p.reason
          ? '<div class="blocked">' + SiteCrm.escape(p.reason) + '</div>' : '')
      + '</div>';
    return el;
  }

  /** 真正下单：`method` 是用户选的那一种（可选，缺省由 SDK 用第一种） */
  function checkout(planId, method, done) {
    var opts = { planId: planId };
    if (method) { opts.method = method; }
    SiteCrm.checkout(opts).then(function (r) {
      flash('ok', '已打开支付页（单号 ' + r.orderCode + '）。付完后回到本站，「我的」里就会显示最新状态。');
    }).catch(function (e) {
      if (e.code === 'http_401' || e.code === 'unauthorized') {
        location.assign('login.html?next=pricing.html');
        return;
      }
      flash('err', e.message || '下单失败，请稍后再试');
    }).finally(done);
  }

  /** 打开确认对话框：金额 + 支付方式都在这里，卡片布局不动 */
  var dlg = null;
  function closeDlg() {
    if (dlg) {
      if (dlg.open) dlg.close();
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      dlg = null;
    }
  }

  function openPay(plan) {
    closeDlg();
    var options = plan.method_options || [];
    dlg = document.createElement('dialog');
    dlg.className = 'paydlg';
    dlg.innerHTML =
      '<div class="paydlg-head">'
      + '<h2>' + SiteCrm.escape(plan.name || '确认支付') + '</h2>'
      + '<button class="paydlg-x" type="button" aria-label="关闭">×</button>'
      + '</div>'
      + '<div class="paydlg-amount"><span class="now">' + SiteCrm.escape(plan.price || '')
      + '</span>' + (plan.compareAt
        ? '<span class="was">' + SiteCrm.escape(plan.compareAt) + '</span>' : '')
      + '</div>'
      + '<div class="paydlg-per">'
      + (plan.action === 'renewal' ? '续订价' : '实付价格') + '</div>'
      + '<div class="paydlg-label">选择支付方式</div>'
      + '<div class="paydlg-methods">'
      + (options.length
        ? options.map(function (m) {
            return '<button class="btn paydlg-m" type="button" data-method="'
              + SiteCrm.escape(m.id) + '">' + SiteCrm.escape(m.label) + '</button>';
          }).join('')
        : '<p class="hint">这一档暂时没有可用的支付方式。</p>')
      + '</div>'
      + '<button class="ghost paydlg-cancel" type="button">取消</button>';

    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal();

    dlg.querySelector('.paydlg-x').addEventListener('click', closeDlg);
    dlg.querySelector('.paydlg-cancel').addEventListener('click', closeDlg);
    // 点遮罩关闭（dialog 本身接收点击，内容区会冒泡到它）
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) closeDlg(); });

    Array.prototype.forEach.call(dlg.querySelectorAll('[data-method]'), function (m) {
      m.addEventListener('click', function () {
        var all = dlg.querySelectorAll('button');
        Array.prototype.forEach.call(all, function (b) { b.disabled = true; });
        m.textContent = '正在准备支付…';
        checkout(plan.id, m.getAttribute('data-method'), function () {
          closeDlg();
        });
      });
    });
  }

  function buy(btn) {
    // 需要登录的档位：一步到位跳登录，回来接着买（不发起下单请求）
    if (btn.getAttribute('data-login') === '1') {
      location.assign('login.html?next=pricing.html');
      return;
    }
    var plan = ALL[btn.getAttribute('data-plan')] || {};
    openPay(plan);
  }

  SiteCrm.plans().then(function (plans) {
    var box = $('plans');
    box.innerHTML = '';
    if (!plans.length) {
      box.innerHTML = '<div class="card empty">现在没有在售套餐，请稍后再来。</div>';
      return;
    }
    box.classList.toggle('cols-3', plans.length > 2);
    box.classList.toggle('solo', plans.length === 1);
    plans.forEach(function (p) {
      ALL[p.id] = p;
      box.appendChild(card(p));
    });
  }).catch(function () {
    // 设计过的失败态：不要甩原始错误，给一个能重试的卡片
    $('plans').innerHTML =
      '<div class="card empty"><p>套餐暂时加载不出来。</p>' +
      '<p class="hint">可能是网络波动；刷新一下就能重试。</p>' +
      '<button class="btn ghost sm" type="button" id="plans-retry">重新加载</button></div>';
    var retry = document.getElementById('plans-retry');
    if (retry) {
      retry.addEventListener('click', function () { location.reload(); });
    }
  });

  $('plans').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-plan]');
    if (btn) buy(btn);
  });
})();
