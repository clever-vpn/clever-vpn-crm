// ── 登录态：Bearer token（存在 localStorage）──────────────────────
//
// 这个静态站和 CRM **不同源**，所以不用 Cookie：登录后把 `/auth/verify` 返回的
// `session_token` 存进 localStorage，之后每个请求带上 `Authorization: Bearer`。
//
// 安全取舍（有意为之，别当成疏漏）：token 可以被同源脚本读到。这里只承载"用户的
// 套餐权益"，泄露的实际损失有限；换来的是不用 BFF 代理、不用 CORS 凭据、
// 不用应付各家浏览器的第三方 Cookie 政策。

/** CRM 地址，来自 config.js */
var API_BASE = String(window.CRM_API_BASE || "").replace(/\/+$/, "");

var CrmAuth = {
  KEY: "crm_token",
  get: function () {
    try {
      return localStorage.getItem(CrmAuth.KEY) || "";
    } catch (e) {
      return "";
    }
  },
  set: function (token) {
    try {
      localStorage.setItem(CrmAuth.KEY, token);
    } catch (e) {
      /* 隐私模式：忽略，下次再登录 */
    }
  },
  clear: function () {
    try {
      localStorage.removeItem(CrmAuth.KEY);
    } catch (e) {
      /* 同上 */
    }
  },
};

// 只给"打到 CRM 的请求"注入 Authorization；本站的 CSS/图片不掺和。
(function () {
  if (!API_BASE) {
    console.warn("[crm] config.js 里还没有填 CRM_API_BASE，接口调用会失败");
    return;
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url ? input.url : "";
    if (url.indexOf(API_BASE) !== 0) return realFetch(input, init);
    var opts = init || {};
    var headers = new Headers(opts.headers || {});
    var token = CrmAuth.get();
    if (token && !headers.has("authorization")) {
      headers.set("authorization", "Bearer " + token);
    }
    opts.headers = headers;
    return realFetch(input, opts);
  };
})();
