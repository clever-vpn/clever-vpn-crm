/* account.html 的页面脚本。
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
  var fmtDate = function (iso) { return iso ? String(iso).slice(0, 10) : '—'; };
  function yuan(minor) {
    return typeof minor === 'number' ? '¥' + (minor / 100).toFixed(2) : '—';
  }
  var STATUS = {
    active: ['ok', '可用'],
    inactive: ['warn', '不可用'],
    provisioning: ['warn', '开通中'],
    none: ['warn', '未订阅']
  };

  function rows(dl, pairs) {
    dl.innerHTML = pairs.map(function (kv) {
      return '<dt>' + SiteCrm.escape(kv[0]) + '</dt><dd>' + SiteCrm.escape(kv[1]) + '</dd>';
    }).join('');
  }

  function renderMe(me) {
    var s = (me && me.subscription) || {};
    var tag = STATUS[s.status] || ['warn', s.status || '—'];
    $('state-tag').className = 'tag ' + tag[0];
    $('state-tag').textContent = tag[1];

    var pairs = [
      ['账号', (me && me.user && me.user.email) || '—'],
      ['状态', s.status === 'provisioning' ? '正在开通…' : (s.status_text || '—')],
      ['套餐', s.plan_id || '—'],
      ['到期', fmtDate(s.expires_at)],
      ['剩余额度', s.unlimited ? '不限量'
        : (s.remaining_gb == null ? '—' : s.remaining_gb + ' GB')],
      ['设备数', s.licence_limit == null ? '—' : String(s.licence_limit)]
    ];
    if (s.status === 'inactive' && s.reason === 'frozen') {
      pairs.push(['提示', '如需恢复，请联系客服']);
    }
    rows($('me'), pairs);
  }

  function renderReferral(ref) {
    if (!ref) { return; }
    $('invite-code').textContent = ref.code || '生成失败，请联系客服';
    $('invite-count').textContent = '已邀请 ' + (ref.invited || 0) + ' 人';
    var reward = [ref.reward_days ? ref.reward_days + ' 天' : '',
                  ref.reward_gb ? ref.reward_gb + ' GB' : '']
                  .filter(Boolean).join(' + ') || '—';
    rows($('invite'), [
      ['已邀请', (ref.invited || 0) + ' 人（已完成首单）'],
      ['累计奖励', reward]
    ]);
  }

  function planName(o) {
    try {
      var v = JSON.parse(o.plan_snapshot || '{}');
      return v.name || '—';
    } catch (e) { return '—'; }
  }

  function renderOrders(items) {
    var body = $('orders');
    if (!items || !items.length) {
      body.innerHTML = '<tr><td colspan="5" class="hint">还没有订单</td></tr>';
      return;
    }
    body.innerHTML = items.map(function (o) {
      return '<tr>'
        + '<td class="mono">' + SiteCrm.escape(o.code || o.order_code || '—') + '</td>'
        + '<td>' + SiteCrm.escape(planName(o)) + '</td>'
        + '<td class="num">' + yuan(o.amount_minor) + '</td>'
        + '<td>' + SiteCrm.escape(o.status || '—') + '</td>'
        + '<td>' + fmtDate(o.created_at) + '</td>'
        + '</tr>';
    }).join('');
  }

  $('copy').addEventListener('click', function () {
    var code = $('invite-code').textContent || '';
    if (!code || code === '—') { return; }
    navigator.clipboard.writeText(code).then(function () {
      flash('ok', '已复制邀请码 ' + code);
    }, function () {
      var range = document.createRange();
      range.selectNodeContents($('invite-code'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      flash('err', '复制失败，请手动选中上面的码');
    });
  });

  $('redeem-btn').addEventListener('click', function () {
    var code = ($('redeem-code').value || '').trim().toUpperCase();
    var box = $('redeem-result');
    if (!code) {
      box.innerHTML = '<div class="err">请输入兑换码</div>';
      return;
    }
    $('redeem-btn').disabled = true;
    box.innerHTML = '<div class="hint">正在兑换…</div>';
    SiteCrm.redeem(code).then(function (d) {
      // 业务性失败是 200 + ok:false + reason，不是异常
      if (!d || d.ok !== true) {
        box.innerHTML = '<div class="err">'
          + SiteCrm.escape((d && d.reason) || '兑换失败') + '</div>';
        return;
      }
      var bits = [];
      var a = d.applied || {};
      if (a.days) { bits.push('+' + a.days + ' 天'); }
      if (a.gb) { bits.push('+' + a.gb + ' GB'); }
      if (a.reset_month) { bits.push('重置本月已用'); }
      var head = d.opened ? '已开通体验套餐' : '「' + (d.promotion_name || '兑换码') + '」已到账';
      var detail = bits.length ? '：' + bits.join(' + ') : '';
      var tail = d.expires_at ? '，有效期至 ' + fmtDate(d.expires_at) : '';
      box.innerHTML = '<div class="ok">' + SiteCrm.escape(head + detail + tail) + '</div>';
      $('redeem-code').value = '';
      load();   // 权益变了，上面那张卡立刻刷新
    }).catch(function (e) {
      box.innerHTML = '<div class="err">'
        + SiteCrm.escape(e.message || '兑换失败') + '</div>';
    }).finally(function () {
      $('redeem-btn').disabled = false;
    });
  });

  $('redeem-code').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { $('redeem-btn').click(); }
  });

  $('logout').addEventListener('click', function () {
    SiteCrm.logout().then(function () { location.assign('index.html'); });
  });

  function load() {
    return SiteCrm.me().then(function (me) {
      if (!me) {
        location.assign('login.html?next=account.html');
        return;
      }
      renderMe(me);
      renderReferral(me.referral);
      return SiteCrm.orders({ limit: 20 }).then(renderOrders);
    }).catch(function (e) {
      flash('err', '加载失败：' + (e.message || '请稍后重试'));
    });
  }

  load();
})();
