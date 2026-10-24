/**
 * 映射解释器测试
 *
 * 关键点：**签名用 `node:crypto` 独立算一遍**再和实现比对 —— 否则就是用同一段
 * 代码验证自己，签错也测不出来。
 *
 * 覆盖：易支付（内置）+ 青蛙 / 亿宏 / 华俊（仅夹具），四种形状全过同一份解释器。
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EPAY_V1_MAPPING } from "../../src/payments/builtin/epay";
import {
  buildCreateRequest,
  buildQueryRequest,
  formatAmount,
  matchesWhen,
  parseAmount,
  parseCreateResponse,
  parseNotify,
  parseQueryResponse,
  hasQuery,
  readNotifyParams,
  readPath,
  validateMapping,
  type ChargeContext,
  type GatewayMapping,
} from "../../src/payments/mapping";

import { HUAJUN_MAPPING, HUPIJIAO_MAPPING, QWGUA_MAPPING, YIHONG_MAPPING } from "./fixtures";

const KEY = "secret-key";
/** 北京时间 2026-10-24 12:00:00 */
const NOW = new Date("2026-10-24T04:00:00Z");

function ctx(over: Partial<ChargeContext> = {}): ChargeContext {
  return {
    merchant: "M1000",
    secret: KEY,
    orderNo: "ORD-20261024-0001",
    amountMinor: 1234,
    currency: "CNY",
    subject: "月付 · 100GB",
    method: "alipay",
    notifyUrl: "https://crm.example.com/notify",
    returnUrl: "https://crm.example.com/return",
    clientIp: "1.2.3.4",
    endpoint: "https://pay.example.com",
    now: NOW,
    ...over,
  };
}

/** 独立参考实现（node:crypto），用来交叉验证 @noble 那条路径 */
function refSign(
  params: Record<string, unknown>,
  exclude: string[],
  keyAppend = "",
  key = KEY,
): string {
  const body = Object.keys(params)
    .filter((k) => !exclude.includes(k) && String(params[k] ?? "") !== "")
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");
  return createHash("md5").update(`${body}${keyAppend}${key}`).digest("hex");
}

function bodyParams(body: string | null, format: "form" | "json"): Record<string, string> {
  expect(body).toBeTruthy();
  if (format === "json") return JSON.parse(body!) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(body!));
}

function signOf(payload: Record<string, unknown>): string {
  return String(payload.sign ?? "");
}

describe("内置映射 epay_v1", () => {
  it("自校验通过", () => {
    const r = validateMapping(EPAY_V1_MAPPING);
    expect(r.ok).toBe(true);
  });

  it("下单：form 编码、金额按元、签名与 node:crypto 一致", () => {
    const req = buildCreateRequest(EPAY_V1_MAPPING, ctx());
    expect(req.url).toBe("https://pay.example.com/mapi.php");
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const p = bodyParams(req.body, "form");
    expect(p.pid).toBe("M1000");
    expect(p.type).toBe("alipay");
    expect(p.money).toBe("12.34"); // 1234 分 → 元
    expect(p.out_trade_no).toBe("ORD-20261024-0001");
    expect(p.sign_type).toBe("MD5");
    expect(signOf(p)).toBe(refSign(p, ["sign", "sign_type"], ""));
  });

  it("回调：GET 查询串，trade_status=TRADE_SUCCESS 才算已付", () => {
    const params: Record<string, unknown> = {
      pid: "M1000",
      trade_no: "E123",
      out_trade_no: "ORD-20261024-0001",
      type: "alipay",
      money: "12.34",
      trade_status: "TRADE_SUCCESS",
    };
    params.sign = refSign(params, ["sign", "sign_type"]);
    params.sign_type = "MD5";

    const r = parseNotify(EPAY_V1_MAPPING, params, KEY);
    expect(r.signOk).toBe(true);
    expect(r.paid).toBe(true);
    expect(r.orderNo).toBe("ORD-20261024-0001");
    expect(r.tradeNo).toBe("E123");
    expect(r.amountMinor).toBe(1234);
  });

  it("回调：金额被改则验签失败", () => {
    const params: Record<string, unknown> = {
      out_trade_no: "ORD-20261024-0001",
      money: "12.34",
      trade_status: "TRADE_SUCCESS",
    };
    params.sign = refSign(params, ["sign", "sign_type"]);
    params.money = "0.01";
    const r = parseNotify(EPAY_V1_MAPPING, params, KEY);
    expect(r.signOk).toBe(false);
  });

  it("回调：未付款的通知不判已付", () => {
    const params: Record<string, unknown> = {
      out_trade_no: "ORD-20261024-0001",
      money: "12.34",
      trade_status: "WAIT_BUYER_PAY",
    };
    params.sign = refSign(params, ["sign", "sign_type"]);
    expect(parseNotify(EPAY_V1_MAPPING, params, KEY).paid).toBe(false);
  });

  it("查单：GET、不签名、status=1 才算已付", () => {
    const req = buildQueryRequest(EPAY_V1_MAPPING, ctx());
    expect(req.url).toContain("https://pay.example.com/api.php?");
    expect(req.url).toContain("act=order");
    expect(req.url).toContain("pid=M1000");
    expect(req.url).toContain(`key=${KEY}`);
    expect(req.url).toContain("out_trade_no=ORD-20261024-0001");
    expect(req.url).not.toContain("sign=");

    const unpaid = parseQueryResponse(EPAY_V1_MAPPING, { code: 1, status: 0, money: "12.34" });
    expect(unpaid.paid).toBe(false);
    const paid = parseQueryResponse(EPAY_V1_MAPPING, { code: 1, status: 1, money: "12.34" });
    expect(paid.paid).toBe(true);
    expect(paid.amountMinor).toBe(1234);
  });
});

describe("夹具：青蛙（JSON + 北京时间 ymdhms）", () => {
  it("自校验通过", () => {
    expect(validateMapping(QWGUA_MAPPING).ok).toBe(true);
  });

  it("下单：JSON、金额按元、requestTime=YYYYMMDDHHmmss(UTC+8)", () => {
    const req = buildCreateRequest(QWGUA_MAPPING, ctx());
    expect(req.url).toBe("https://pay.example.com/pay/create");
    expect(req.headers["Content-Type"]).toBe("application/json");

    const p = bodyParams(req.body, "json");
    expect(p.mchId).toBe("M1000");
    expect(p.code).toBe("1888"); // 渠道码
    expect(p.amount).toBe("12.34");
    expect(p.requestTime).toBe("20261024120000");
    expect(p.mchOrderNo).toBe("ORD-20261024-0001");
    expect(signOf(p)).toBe(refSign(p, ["sign"], ""));
  });

  it("响应：payUrl 在 data 下", () => {
    const r = parseCreateResponse(QWGUA_MAPPING, {
      code: "200",
      data: { payUrl: "https://pay.example.com/cashier/1", sysOrderNo: "S-1" },
    });
    expect(r.ok).toBe(true);
    expect(r.payUrl).toBe("https://pay.example.com/cashier/1");
    expect(r.tradeNo).toBe("S-1");
  });

  it("查单：data.status=3 已付", () => {
    const r = parseQueryResponse(QWGUA_MAPPING, { code: "200", data: { status: "3", amount: "12.34" } });
    expect(r.paid).toBe(true);
    expect(r.amountMinor).toBe(1234);
  });
});

describe("夹具：亿宏（form + 回调/查单两套状态码）", () => {
  it("自校验通过", () => {
    expect(validateMapping(YIHONG_MAPPING).ok).toBe(true);
  });

  it("下单：form、format/attach 不参与签名", () => {
    const req = buildCreateRequest(YIHONG_MAPPING, ctx());
    const p = bodyParams(req.body, "form");
    expect(p.userId).toBe("M1000");
    expect(p.type).toBe("180");
    expect(p.amount).toBe("12.34");
    expect(p.format).toBe("json");
    expect(signOf(p)).toBe(refSign(p, ["sign", "format", "attach"], ""));
  });

  it("响应：datas.url 强制升级 https", () => {
    const r = parseCreateResponse(YIHONG_MAPPING, {
      code: "200",
      datas: { url: "http://pay.example.com/cashier/2" },
    });
    expect(r.ok).toBe(true);
    expect(r.payUrl).toBe("https://pay.example.com/cashier/2");
  });

  it("回调 status=1 已付；查单 status=1 未付、status=3 已付（两套语义）", () => {
    const notifyParams: Record<string, unknown> = {
      requestNo: "ORD-20261024-0001",
      amount: "12.34",
      status: "1",
    };
    notifyParams.sign = refSign(notifyParams, ["sign", "format", "attach"]);
    expect(parseNotify(YIHONG_MAPPING, notifyParams, KEY).paid).toBe(true);

    expect(parseQueryResponse(YIHONG_MAPPING, { code: "200", datas: { status: "1" } }).paid).toBe(false);
    expect(parseQueryResponse(YIHONG_MAPPING, { code: "200", datas: { status: "3", amount: "12.34" } }).paid).toBe(true);
  });

  it("回调带 attach 时用替代字段集合验签（exclude_variants）", () => {
    const params: Record<string, unknown> = {
      requestNo: "ORD-20261024-0001",
      amount: "12.34",
      status: "1",
      attach: "x",
    };
    // 厂商签名时排除了 attach ⇒ 我们的基集也应包含 attach
    params.sign = refSign(params, ["sign", "format", "attach"]);
    expect(parseNotify(YIHONG_MAPPING, params, KEY).signOk).toBe(true);
  });
});

describe("夹具：华俊（JSON + 金额按分 + 毫秒 + &key=）", () => {
  it("自校验通过", () => {
    expect(validateMapping(HUAJUN_MAPPING).ok).toBe(true);
  });

  it("下单：金额是分、reqTime 13 位、签名用 &key=", () => {
    const req = buildCreateRequest(HUAJUN_MAPPING, ctx());
    const p = bodyParams(req.body, "json");
    expect(Number(p.amount)).toBe(1234); // 分，不除以 100
    expect(Number(p.wayCode)).toBe(901); // 渠道码是整数
    expect(p.reqTime).toBe(String(NOW.getTime()));
    expect(p.clientIp).toBe("1.2.3.4");
    expect(signOf(p)).toBe(refSign(p, ["sign"], "&key="));
  });

  it("响应：code=0 成功，data.payUrl", () => {
    const r = parseCreateResponse(HUAJUN_MAPPING, {
      code: 0,
      message: "",
      data: { tradeNo: "P2021", outTradeNo: "ORD-20261024-0001", amount: "1234", payUrl: "https://pay.example.com/p" },
    });
    expect(r.ok).toBe(true);
    expect(r.payUrl).toBe("https://pay.example.com/p");
    expect(r.tradeNo).toBe("P2021");
  });

  it("回调 state=1 已付；查单 state=2 是终态", () => {
    const notifyParams: Record<string, unknown> = {
      mchId: "M1000",
      tradeNo: "P2021",
      outTradeNo: "ORD-20261024-0001",
      amount: 1234,
      state: 1,
      notifyTime: 1622016572190,
    };
    notifyParams.sign = refSign(notifyParams, ["sign"], "&key=");
    const n = parseNotify(HUAJUN_MAPPING, notifyParams, KEY);
    expect(n.signOk).toBe(true);
    expect(n.paid).toBe(true);
    expect(n.amountMinor).toBe(1234);

    const failed = parseQueryResponse(HUAJUN_MAPPING, { code: 0, data: { state: 2 } });
    expect(failed.paid).toBe(false);
    expect(failed.terminal).toBe(true);

    const paid = parseQueryResponse(HUAJUN_MAPPING, { code: 0, data: { state: 1, amount: "1234" } });
    expect(paid.paid).toBe(true);
    expect(paid.amountMinor).toBe(1234);
  });
});

describe("读取回调参数", () => {
  it("GET 查询串", async () => {
    const req = new Request("https://crm.example.com/notify?out_trade_no=X&money=1.00");
    const p = await readNotifyParams(EPAY_V1_MAPPING, req);
    expect(p.out_trade_no).toBe("X");
  });

  it("POST JSON", async () => {
    const req = new Request("https://crm.example.com/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outTradeNo: "Y", amount: 1234, state: 1 }),
    });
    const p = await readNotifyParams(HUAJUN_MAPPING, req);
    expect(p.outTradeNo).toBe("Y");
  });

  it("POST form", async () => {
    const req = new Request("https://crm.example.com/notify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "requestNo=Z&amount=12.34&status=1",
    });
    const p = await readNotifyParams(YIHONG_MAPPING, req);
    expect(p.requestNo).toBe("Z");
  });
});

describe("工具函数", () => {
  it("readPath 支持点号与缺失", () => {
    expect(readPath({ data: { payUrl: "x" } }, "data.payUrl")).toBe("x");
    expect(readPath({ data: null }, "data.payUrl")).toBeUndefined();
    expect(readPath({}, "a.b.c")).toBeUndefined();
  });

  it("matchesWhen 数字/字符串宽松比较", () => {
    const spec = { path: "code", equals: 1 };
    expect(matchesWhen(spec, { code: 1 })).toBe(true);
    expect(matchesWhen(spec, { code: "1" })).toBe(true);
    expect(matchesWhen(spec, { code: 2 })).toBe(false);
    expect(matchesWhen({ path: "s", in: ["A", "B"] }, { s: "B" })).toBe(true);
    expect(matchesWhen({ path: "s", in: ["A"] }, {})).toBe(false);
  });

  it("金额换算：元/分，且元要能解析两位小数", () => {
    expect(formatAmount(1234, "yuan")).toBe("12.34");
    expect(formatAmount(1234, "cent")).toBe(1234);
    expect(parseAmount("12.34", "yuan")).toBe(1234);
    expect(parseAmount("1234", "cent")).toBe(1234);
    expect(parseAmount(0.1, "yuan")).toBe(10);
    expect(parseAmount("abc", "yuan")).toBeNull();
    expect(parseAmount(undefined, "yuan")).toBeNull();
  });
});

describe("校验（错误必须说清哪个键不对）", () => {
  const base: GatewayMapping = {
    create: { path: "/pay" },
    fields: { merchant: "mch", order_no: "no", amount: "amt" },
    amount_unit: "yuan",
    response: { ok: { path: "code", equals: 1 }, pay_url: "url" },
    notify: { order_no: "no", paid_when: { path: "status", equals: 1 }, reply: "success" },
    query: { path: "/q", fields: {}, paid_when: { path: "status", equals: 1 } },
  };

  it("最小可用配置通过", () => {
    expect(validateMapping(base).ok).toBe(true);
  });

  it("缺 amount_unit 会报错（防止 100 倍的金额事故）", () => {
    const r = validateMapping({ ...base, amount_unit: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("amount_unit");
  });

  it("判定条件必须写 equals 或 in", () => {
    const r = validateMapping({ ...base, response: { ok: { path: "code" }, pay_url: "u" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("equals 或 in");
  });

  it("缺 notify.reply 会报错", () => {
    const r = validateMapping({ ...base, notify: { order_no: "no", paid_when: { path: "s", equals: 1 } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("notify.reply");
  });

  it("没有 pay_url 也没有 pay_url_from 会报错", () => {
    const r = validateMapping({ ...base, response: { ok: { path: "code", equals: 1 } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("pay_url");
  });
});

describe("夹具：虎皮椒（hash / errcode=0 / nonce_str / 无查单）", () => {
  it("自校验通过（没有 query 也合法）", () => {
    const r = validateMapping(HUPIJIAO_MAPPING);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(hasQuery(HUPIJIAO_MAPPING)).toBe(false);
  });

  it("支付宝：type 整个参数不出现；微信用 WAP", () => {
    const ali = bodyParams(buildCreateRequest(HUPIJIAO_MAPPING, ctx()).body, "form");
    expect("type" in ali).toBe(false);

    const wx = bodyParams(
      buildCreateRequest(HUPIJIAO_MAPPING, ctx({ method: "wechat" })).body,
      "form",
    );
    expect(wx.type).toBe("WAP");
  });

  it("nonce_str 每次不同，且是 32 位 hex", () => {
    const a = bodyParams(buildCreateRequest(HUPIJIAO_MAPPING, ctx()).body, "form");
    const b = bodyParams(buildCreateRequest(HUPIJIAO_MAPPING, ctx()).body, "form");
    expect(a.nonce_str).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce_str).not.toBe(b.nonce_str);
  });

  it("签名写进 hash（不是 sign），算法仍是直接拼密钥", () => {
    const p = bodyParams(buildCreateRequest(HUPIJIAO_MAPPING, ctx()).body, "form");
    expect("sign" in p).toBe(false);
    expect(p.hash).toBe(refSign(p, ["hash"], ""));
  });

  it("响应：errcode=0 成功，url 优先于 url_qrcode", () => {
    const both = parseCreateResponse(HUPIJIAO_MAPPING, {
      errcode: "0",
      url: "https://pay.example.com/h5/1",
      url_qrcode: "https://pay.example.com/qr/1",
    });
    expect(both.ok).toBe(true);
    expect(both.payUrl).toBe("https://pay.example.com/h5/1");

    const qrOnly = parseCreateResponse(HUPIJIAO_MAPPING, { errcode: "0", url_qrcode: "https://pay.example.com/qr/1" });
    expect(qrOnly.payUrl).toBe("https://pay.example.com/qr/1");

    expect(parseCreateResponse(HUPIJIAO_MAPPING, { errcode: "402", errmsg: "校验信息错误" }).ok).toBe(false);
  });

  it("回调：status=OD 才算已付，金额按元解析", () => {
    const params: Record<string, unknown> = {
      appid: "M1000",
      trade_order_id: "ORD-20261024-0001",
      transaction_id: "PAY20231016001",
      total_fee: "0.01",
      order_title: "月付 · 100GB",
      status: "OD",
      time: "1697452800",
      nonce_str: "abc123def456",
    };
    params.hash = refSign(params, ["hash"], "");

    const n = parseNotify(HUPIJIAO_MAPPING, params, KEY);
    expect(n.signOk).toBe(true);
    expect(n.paid).toBe(true);
    expect(n.orderNo).toBe("ORD-20261024-0001");
    expect(n.tradeNo).toBe("PAY20231016001");
    expect(n.amountMinor).toBe(1);

    // 未支付的通知（status 不是 OD）
    const unpaid: Record<string, unknown> = { ...params, status: "WAIT" };
    unpaid.hash = refSign(unpaid, ["hash"], "");
    expect(parseNotify(HUPIJIAO_MAPPING, unpaid, KEY).paid).toBe(false);
  });

  it("没有查单接口：buildQueryRequest 会抛错", () => {
    expect(() => buildQueryRequest(HUPIJIAO_MAPPING, { ...ctx(), amountMinor: 100 })).toThrow(/没有配置查单/);
    expect(parseQueryResponse(HUPIJIAO_MAPPING, {}).message).toContain("不支持查单");
  });
});

describe("分方向金额单位（下单按元、回调按分）", () => {
  // XArrPay 原生协议的形状：下单 money 是元，回调 amount 是分
  const mixed: GatewayMapping = {
    ...HUPIJIAO_MAPPING,
    amount_unit: "yuan",
    notify_amount_unit: "cent",
    notify: { ...HUPIJIAO_MAPPING.notify, amount: "amount" },
  };

  it("下单仍是元", () => {
    const p = bodyParams(buildCreateRequest(mixed, ctx()).body, "form");
    expect(p.total_fee).toBe("12.34");
  });

  it("回调按分解析，不会放大 100 倍", () => {
    const params: Record<string, unknown> = {
      trade_order_id: "ORD-20261024-0001",
      amount: "1234",
      status: "OD",
    };
    params.hash = refSign(params, ["hash"], "");
    expect(parseNotify(mixed, params, KEY).amountMinor).toBe(1234);
  });

  it("不配 notify_amount_unit 时才跟随 amount_unit（这里会错成 123400，说明为什么必须配）", () => {
    const wrong = { ...mixed, notify_amount_unit: undefined };
    const params: Record<string, unknown> = { trade_order_id: "X", amount: "1234", status: "OD" };
    params.hash = refSign(params, ["hash"], "");
    expect(parseNotify(wrong, params, KEY).amountMinor).toBe(123400);
  });
});
