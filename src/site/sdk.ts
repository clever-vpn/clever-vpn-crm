/**
 * 平台 SDK：`window.SiteCrm`（契约 `contracts/site-crm.md` §4.3 / §6）
 *
 * 定位：**唯一碰凭证的代码**。页面只调函数，不碰 token、不自己拼金额。
 *
 * 三条配套（不许省）：
 *  1. 不暴露 token —— 没有 `SiteCrm.token` / `getToken`
 *  2. 只增不改 —— 不删方法、不改签名，`version` 单调递增
 *  3. 失败一律抛 `{ code, message }`，`message` 是给终端用户看的整句中文
 *
 * 为什么**不** patch `window.fetch`：页面自己 fetch 到 CRM 不会带 token，自然拿不到
 * 数据 —— 想调接口就只有走 SDK。这样"凭证能力"不会散到每份模板里。
 */

const CTA: Record<string, string> = {
  buy: "立即购买",
  renewal: "续订",
  upgrade: "升级到这个套餐",
  login_required: "登录后订阅",
  blocked: "暂不可购买",
};

export const SDK_VERSION = "1.0.0";

/** 内嵌到 `/_crm/sdk.js`；不依赖构建步骤，字符串原样送出 */
export const SDK_JS = `(function () {
  var BASE = String(window.CRM_API_BASE || "").replace(/\\/$/, "");
  if (!BASE && window.console) { console.warn("[crm] CRM_API_BASE 未配置"); }
  var TOKEN_KEY = "crm_token";
  var CTA = ${JSON.stringify(CTA)};
  var authCbs = [];

  function token() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) {
    try { if (t) { localStorage.setItem(TOKEN_KEY, t); } else { localStorage.removeItem(TOKEN_KEY); } } catch (e) {}
    if (t) { for (var i = 0; i < authCbs.length; i++) { try { authCbs[i](null); } catch (e) {} } }
  }
  function crmError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    e.message = message || code;
    return e;
  }
  function defaultMessage(status) {
    if (status === 401) return "请先登录";
    if (status === 404) return "找不到对应内容";
    if (status === 409) return "状态已变化，请刷新后重试";
    if (status === 429) return "操作太频繁，请稍后再试";
    if (status >= 500) return "服务暂时不可用，请稍后再试";
    return "请求失败";
  }
  function api(method, path, body) {
    var headers = {};
    var t = token();
    if (t) { headers["authorization"] = "Bearer " + t; }
    if (body !== undefined) { headers["content-type"] = "application/json"; }
    return fetch(BASE + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) {
          var e = data && data.error;
          throw crmError((e && e.code) || ("http_" + res.status),
            (e && e.message) || defaultMessage(res.status));
        }
        return data;
      });
    }, function () {
      throw crmError("network", "网络不通，请检查后重试");
    });
  }
  function money(minor, currency) {
    if (typeof minor !== "number") { return ""; }
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency", currency: currency || "CNY"
      }).format(minor / 100);
    } catch (e) {
      return (minor / 100).toFixed(2) + " " + (currency || "");
    }
  }
  function specs(p) {
    var out = [];
    if (p.kind === "period") {
      out.push(p.monthly_quota_gb == null ? "每月不限量" : "每月 " + p.monthly_quota_gb + " GB");
    } else if (p.kind === "traffic") {
      out.push(p.traffic_gb == null ? "不限量" : "共 " + p.traffic_gb + " GB");
    } else if (p.kind === "addon") {
      out.push(p.traffic_gb == null ? "加量包" : "加 " + p.traffic_gb + " GB");
    }
    var days = p.validity_days == null ? p.term_days : p.validity_days;
    if (typeof days === "number") { out.push(days + " 天有效期"); }
    if (typeof p.licence_limit === "number") { out.push(p.licence_limit + " 台设备"); }
    if (p.action === "renewal" && p.next_expires_at) {
      out.push("续订后有效期至 " + String(p.next_expires_at).slice(0, 10));
    }
    return out;
  }
  function planView(p) {
    var price = typeof p.display_price_minor === "number" ? p.display_price_minor : p.price_minor;
    return {
      id: p.plan_id,
      name: p.name,
      kind: p.kind,
      price: money(price, p.currency),
      compareAt: typeof p.compare_at_price_minor === "number"
        ? money(p.compare_at_price_minor, p.currency) : null,
      badge: p.promo_badge || null,
      specs: specs(p),
      cta: CTA[p.action] || "立即购买",
      action: p.action,
      buyable: p.buyable !== false,
      reason: p.reason || null
    };
  }

  /** 把支付页交给**外部浏览器**：App 里由宿主提供 bridge，其余环境尽量新开窗口 */
  function openExternal(url) {
    try {
      var b = window.SiteCrmBridge;
      if (b && typeof b.openExternal === "function") { b.openExternal(url); return "bridge"; }
    } catch (e) {}
    var win = null;
    try { win = window.open(url, "_blank", "noopener"); } catch (e) {}
    if (win) { return "window"; }
    try { location.assign(url); return "same"; } catch (e) {}
    return "none";
  }

  var SiteCrm = {
    version: ${JSON.stringify(SDK_VERSION)},
    escape: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    },
    plans: function () {
      return api("GET", "/plans").then(function (list) {
        return (list || []).map(planView);
      });
    },
    sendCode: function (email) {
      return api("POST", "/auth/send-code", { email: email }).then(function (d) {
        // devCode 只在开发环境回显（线上永远没有这个字段）
        return { cooldown: (d && d.cooldown) || 60, devCode: (d && d.code) || null };
      });
    },
    verify: function (email, code, ref) {
      var body = { email: email, code: code, appId: "website" };
      if (ref) { body.referral_code = ref; }
      return api("POST", "/auth/verify", body).then(function (d) {
        var t = d && (d.session_token || d.token);
        if (t) { setToken(t); }
        return d || {};
      });
    },
    logout: function () {
      return api("POST", "/auth/logout", {}).then(function () {
        setToken("");
      }, function () {
        setToken("");
      });
    },
    me: function () {
      if (!token()) { return Promise.resolve(null); }
      // /me 已经含 user / subscription / referral，不用再打一刀
      return api("GET", "/me").then(function (me) {
        return me;
      }, function (e) {
        if (e && e.code === "http_401") { setToken(""); return null; }
        throw e;
      });
    },
    orders: function (opts) {
      var q = "?pagination[limit]=" + ((opts && opts.limit) || 20);
      if (opts && opts.cursor) { q += "&cursor=" + encodeURIComponent(opts.cursor); }
      return api("GET", "/orders" + q).then(function (d) { return (d && d.items) || []; });
    },
    checkout: function (opts) {
      var planId = (opts && opts.planId) || "";
      var promo = (opts && opts.promo) || "";
      if (!planId) { return Promise.reject(crmError("invalid_request", "缺少套餐")); }
      return api("GET", "/plans").then(function (list) {
        var plan = null;
        for (var i = 0; i < (list || []).length; i++) {
          if (list[i].plan_id === planId) { plan = list[i]; }
        }
        if (!plan) { throw crmError("not_found", "套餐不存在或已下架"); }
        var methods = plan.payment_methods || [];
        if (!methods.length) { throw crmError("no_payment_method", "这一档请在 App 内购买"); }
        var body = { plan_id: planId, promo_code: promo };
        return api("POST", "/quote", body).then(function (q) {
          if (q && q.action === "blocked") {
            throw crmError("not_purchasable", (q && q.reason) || "当前不可购买");
          }
          var expected = q && typeof q.payable_minor === "number" ? q.payable_minor : undefined;
          var order = {
            plan_id: planId,
            payment_method: methods[0].id,
            origin: "web",
            // 付完回**站点的**保底页（不是 CRM 域名）；order=<code> 由服务端拼
            // 路径是产物里的静态文件：/_crm/return.html（发布时写入 R2）
            return_url: location.origin + "/_crm/return.html"
          };
          if (promo) { order.promo_code = promo; }
          if (typeof expected === "number") { order.expected_payable_minor = expected; }
          return api("POST", "/orders", order);
        });
      }).then(function (o) {
        if (!o || !o.pay_url) { throw crmError("no_pay_url", "没有拿到支付地址，请稍后重试"); }
        var how = openExternal(o.pay_url);
        if (how === "none") { throw crmError("open_failed", "打不开支付页，请复制链接手动打开"); }
        return { orderCode: o.code, payUrl: o.pay_url, opened: how };
      });
    },
    payStatus: function (orderCode) {
      if (!orderCode) { return Promise.resolve(null); }
      return api("GET", "/orders/" + encodeURIComponent(orderCode));
    },
    redeem: function (code) {
      return api("POST", "/redeem", { code: code });
    },
    on: function (evt, cb) {
      if (evt === "auth" && typeof cb === "function") { authCbs.push(cb); }
    },
    error: crmError
  };

  window.SiteCrm = SiteCrm;
})();
`;

/**
 * `/_crm/return?order=<code>`：支付回跳的**平台保底页**。
 *
 * 为什么不放在租户模板里：第三方付完是在**外部浏览器**打开的，回来时是新会话，
 * 依赖登录态的页面会失效；而这个页必须永远存在（租户改了模板也不能丢）。
 */
export const RETURN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付结果</title>
<style>
  :root { color-scheme: light }
  body{margin:0;font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;
       color:#0d1626;background:#fff;display:grid;place-items:center;min-height:100vh}
  .box{max-width:420px;padding:28px 22px;text-align:center}
  h1{font-size:20px;margin:0 0 10px}
  p{color:#5c6b82;margin:0 0 8px}
  code{background:#f6f8fc;border-radius:6px;padding:2px 6px;font-size:14px}
  a{display:inline-block;margin-top:20px;padding:11px 20px;border-radius:10px;
    background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}
</style>
</head>
<body>
  <div class="box">
    <h1>支付已提交</h1>
    <p>如果已完成付款，权益通常几秒内到账。</p>
    <p>回到站点后在「我的」里刷新即可看到最新状态。</p>
    <p id="order"></p>
    <a href="/">回到站点</a>
  </div>
  <script>
    (function () {
      var m = /[?&]order=([^&]+)/.exec(location.search);
      if (m) {
        document.getElementById("order").innerHTML =
          '单号 <code>' + SiteCrm_escape(decodeURIComponent(m[1])) + '</code>';
      }
      function SiteCrm_escape(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }
    })();
  </script>
</body>
</html>
`;
