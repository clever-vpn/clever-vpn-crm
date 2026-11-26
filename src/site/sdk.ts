/**
 * 平台 SDK：`window.SiteCrm`（契约 `contracts/clients.md` §4.3 / §6）
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

/**
 * 2.0.0：展示字段（`cta`/`kindLabel`/`specs`）改由 CRM 给，SDK 只透传；
 * `methods` 删除（用 `method_options`）；`me()` 改为 `/me` + `/subscription` 组合。
 */
export const SDK_VERSION = "2.0.0";

/**
 * 内嵌到 `/_crm/sdk.js`；不依赖构建步骤，字符串原样送出。
 *
 * ⚠️ 这段是 **TypeScript 模板字符串**：正文里（含注释）出现反引号会当场把字符串
 * 截断，报的却是一堆 "Expected ;"，看起来完全不像根因。已经踩过三次。
 */
export const SDK_JS = `(function () {
  // 平台写入的 /_crm/config.js 只给 origin（如 https://acme.clever-panel.win），
  // 而 App/站点共用的接口全在 /api/app/v1/* 下 —— 少了这段前缀会打到站点的
  // 404（跨源 404 没有 CORS 头，浏览器报的是 CORS error，极易误判成网络问题）。
  var BASE = String(window.CRM_API_BASE || "").replace(/\\/+$/, "");
  var API = BASE + "/api/app/v1";
  if (!BASE && window.console) { console.warn("[crm] CRM_API_BASE 未配置"); }
  var TOKEN_KEY = "crm_token";
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
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) {
          var e = data && data.error;
          var err = crmError((e && e.code) || ("http_" + res.status),
            (e && e.message) || defaultMessage(res.status));
          // 状态码要留着：CRM 的 401 可能带业务码（如 unauthorized），
          // 只按 code 判断会把"没登录"当成"请求失败"。
          err.status = res.status;
          throw err;
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
  function planView(p) {
    var price = typeof p.display_price_minor === "number" ? p.display_price_minor : p.price_minor;
    return {
      id: p.plan_id,
      name: p.name,
      kind: p.kind,
      // 类型标签、规格行、按钮文案都由 CRM 给；SDK 不映射、不拼
      kindLabel: p.kind_label || p.kind,
      price: money(price, p.currency),
      compareAt: typeof p.compare_at_price_minor === "number"
        ? money(p.compare_at_price_minor, p.currency) : null,
      badge: p.promo_badge || null,
      specs: Array.isArray(p.specs) ? p.specs : [],
      cta: p.cta || "",
      priceNote: p.price_note || "",
      action: p.action,
      buyable: p.buyable !== false,
      reason: p.reason || null,
      // 带 id 的支付方式：下单要回传的是这个 id（label 只给人看）
      method_options: (p.payment_methods || []).map(function (m) {
        return { id: m.id, label: m.label || m.id };
      })
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
      var body = { email: email, code: code };
      if (ref) { body.referral_code = ref; }
      return api("POST", "/auth/verify", body).then(function (d) {
        var t = d && d.session_token;
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
      // 两个端点：/me 是身份+邀请，/subscription 是权益；SDK 组合成页面熟悉的形状。
      // 激活码不是给页面看的：返回前删掉（约定，不是服务端分支）。
      return Promise.all([api("GET", "/me"), api("GET", "/subscription")]).then(function (r) {
        var me = r[0] || {};
        var sub = r[1] || null;
        if (sub) { delete sub.code; }
        return { user: me.user || null, referral: me.referral || null, subscription: sub };
      }, function (e) {
        if (e && (e.status === 401 || e.code === "http_401" || e.code === "unauthorized")) {
          setToken("");
          return null;
        }
        throw e;
      });
    },
    orders: function (opts) {
      var q = "?limit=" + ((opts && opts.limit) || 20);
      if (opts && opts.cursor) { q += "&cursor=" + encodeURIComponent(opts.cursor); }
      return api("GET", "/orders" + q).then(function (d) { return (d && d.items) || []; });
    },
    checkout: function (opts) {
      var planId = (opts && opts.planId) || "";
      var promo = (opts && opts.promo) || "";
      // 用户选的那一种（支付宝 / 微信…）。不传就给第一种 —— 老模板不用改也能跑。
      var want = (opts && opts.method) || "";
      if (!planId) { return Promise.reject(crmError("invalid_request", "缺少套餐")); }
      // 未登录就没有会话：直接说"请先登录"，别让用户看到「这一档买不了」——
      // 那是**白名单/网关**的问题，不是没登录的问题（同一句话会把人带向错误结论）。
      if (!token()) {
        return Promise.reject(crmError("unauthorized", "请先登录后再购买"));
      }
      return api("GET", "/plans").then(function (list) {
        var plan = null;
        for (var i = 0; i < (list || []).length; i++) {
          if (list[i].plan_id === planId) { plan = list[i]; }
        }
        if (!plan) { throw crmError("not_found", "套餐不存在或已下架"); }
        var methods = plan.payment_methods || [];
        if (!methods.length) {
          // 两种原因都会走到这里：这一档只走 App 内购；或当前账号不在私有网关
          // 名单里 / 后台还没配网关。对访客不该暴露内部细节，但要给出可行动
          // 的下一步。
          throw crmError(
            "no_payment_method",
            "这一档暂时无法在网页上购买，请下载 App 或联系客服"
          );
        }
        // 选中的方式必须是**这一档真的能用的**：模板传来的可能是过期数据，
        // 悄悄改成第一种等于用户点了微信却付了支付宝。
        var chosen = methods[0].id;
        if (want) {
          var found = null;
          for (var j = 0; j < methods.length; j++) {
            if (methods[j].id === want) { found = methods[j]; }
          }
          if (!found) {
            throw crmError(
              "payment_method_unavailable",
              "这一档不支持这种支付方式，请换一个"
            );
          }
          chosen = found.id;
        }
        var body = { plan_id: planId, promo_code: promo };
        return api("POST", "/quote", body).then(function (q) {
          if (q && q.action === "blocked") {
            throw crmError("not_purchasable", (q && q.reason) || "当前不可购买");
          }
          var expected = q && typeof q.payable_minor === "number" ? q.payable_minor : null;
          // 只传三样：套餐、支付方式、可选优惠码。回跳地址由服务端按 Origin 推导。
          var order = { plan_id: planId, payment_method: chosen };
          if (promo) { order.promo_code = promo; }
          return api("POST", "/orders", order).then(function (o) {
            // 服务端会重算价；与刚才报价不一致就别把人送去收银台
            if (expected !== null && o && typeof o.amount_minor === "number" && o.amount_minor !== expected) {
              throw crmError("price_changed", "价格有更新，请重新确认后再支付");
            }
            return o;
          });
        });
      }).then(function (o) {
        if (!o || !o.pay_url) { throw crmError("no_pay_url", "没有拿到支付地址，请稍后重试"); }
        var how = openExternal(o.pay_url);
        if (how === "none") { throw crmError("open_failed", "打不开支付页，请复制链接手动打开"); }
        return { orderCode: o.order_code, payUrl: o.pay_url, opened: how };
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
 * `/_crm/return.html?order=<code>`：支付回跳的**平台保底页**。
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
    <h1 id="title">支付已提交</h1>
    <p id="msg">如果已完成付款，权益通常几秒内到账。</p>
    <p>回到站点后在「我的」里刷新即可看到最新状态。</p>
    <p id="order"></p>
    <a href="/">回到站点</a>
  </div>
  <script src="/_crm/config.js"></script>
  <script>
    (function () {
      function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }
      function param(name) {
        var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search);
        return m ? decodeURIComponent(m[1]) : "";
      }
      var order = param("order");
      if (order) {
        document.getElementById("order").innerHTML =
          "单号 <code>" + esc(order) + "</code>";
      }

      var token = param("crm_pay_token");
      var cancel = param("crm_pay_cancel") === "1";
      var pay = param("pay");
      var COPY = {
        paid: ["支付成功", "权益通常几秒内到账。"],
        pending: ["支付确认中", "如果已完成付款，权益通常几秒内到账。"],
        failed: ["支付未完成", "没有产生有效支付，可以返回重新购买。"],
        canceled: ["已取消支付", "没有产生扣款。"]
      };
      function show(kind) {
        var v = COPY[kind];
        if (!v) return;
        document.getElementById("title").textContent = v[0];
        document.getElementById("msg").textContent = v[1];
      }
      if (pay) show(pay);

      // 客户端直接回跳：用 token 触发一次受控查单（CRM 的 refresh 接口）
      if (token && order && window.CRM_API_BASE) {
        var base = String(window.CRM_API_BASE).replace(/\/+$/, "");
        var url = base + "/api/pay/return/" + encodeURIComponent(order) + "/refresh?t=" + encodeURIComponent(token);
        if (cancel) url += "&cancel=1";
        document.getElementById("title").textContent = "正在确认支付结果…";
        fetch(url, { method: "POST" })
          .then(function (res) { return res.json(); })
          .then(function (data) { if (data && data.pay) show(data.pay); })
          .catch(function () {
            document.getElementById("title").textContent = "支付已提交";
            document.getElementById("msg").textContent = "暂时无法确认，回到站点后在「我的」里刷新即可。";
          });
      }
    })();
  </script>
</body>
</html>
`;
