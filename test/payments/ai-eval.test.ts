/**
 * P0：AI 配置助手的**手动评测**。默认跳过，不进 CI。
 *
 * 前置：
 *   npm run dev:local        # 本地 CRM + 已登录 wrangler（studio 网关 DeepSeek BYOK）
 *   AI_EVAL=1 npm run ai:eval
 *
 * 目标不是让 fixture 逐字节相等（合法变体很多），而是给出一张可对比的报告：
 *   - 结构：HTTP / schema / gate
 *   - 语义：端点、字段、金额单位、签名、判定、回复
 *   - 成本：attempts / 耗时
 *
 * 差异只进报告，不直接让测试失败；只有传输/HTTP 错误才算失败。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readAiDocument } from "../../web/src/ai-doc";
import { validateMapping, type GatewayMapping } from "../../src/payments/mapping";
import {
  PRAGUE_MAPPING,
  QWGUA_MAPPING,
  XARRPAY_NATIVE_MAPPING,
  YIHONG_MAPPING,
} from "./fixtures";

const ENABLED = process.env.AI_EVAL === "1";
const BASE = process.env.AI_EVAL_BASE ?? "http://127.0.0.1:8788";
const DOCS_DIR = process.env.AI_EVAL_DOCS_DIR ?? path.resolve("../../clever-vpn-cf-api/docs");
const EMAIL = process.env.AI_EVAL_EMAIL ?? "ops@example.com";
const PASSWORD = process.env.AI_EVAL_PASSWORD ?? "crm-admin-2026";
const XARR_URL = "https://docs.xarr.cn/merchant/api/xarrpay.html";

interface EvalGate {
  status: string;
  missing: string[];
  warnings: string[];
}

interface EvalBody {
  draft?: { classification?: string; template?: { mapping?: GatewayMapping } };
  model?: string;
  attempts?: number;
  gate?: EvalGate;
  error?: string;
  message?: string;
  details?: { errors?: string[]; attempts?: number };
}

interface Check {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
  optional?: boolean;
}

interface Sample {
  name: string;
  expected: GatewayMapping;
  document: string;
  http: number;
  body: EvalBody;
  ms: number;
  checks: Check[];
  schema: boolean;
}

function whenText(when: { path: string; equals?: unknown; in?: unknown[] } | undefined): string {
  if (!when) return "（无）";
  if (when.in && when.in.length === 1) return `${when.path} = ${String(when.in[0])}`;
  if (when.in) return `${when.path} ∈ [${when.in.join(" / ")}]`;
  return `${when.path} = ${String(when.equals ?? "")}`;
}

function amountUnit(mapping: GatewayMapping, api: "create" | "notify" | "query"): string {
  const fields =
    api === "create"
      ? mapping.create.request.fields
      : api === "notify"
        ? mapping.notify.request.fields
        : mapping.query?.request.fields ?? [];
  return fields.find((f) => f.role === "amount")?.unit ?? "（无）";
}

function fieldOf(mapping: GatewayMapping, role: string, side: "create" | "notify" | "query" = "create"): string {
  const fields =
    side === "create"
      ? mapping.create.request.fields
      : side === "notify"
        ? mapping.notify.request.fields
        : mapping.query?.request.fields ?? [];
  return fields.find((f) => f.role === role)?.field ?? "（无）";
}

function check(
  label: string,
  expected: unknown,
  actual: unknown,
  optional = false,
  caseInsensitive = false,
): Check {
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const ok = caseInsensitive ? e.toLowerCase() === a.toLowerCase() : e === a;
  return { label, expected: e, actual: a, ok, optional };
}

function compare(name: string, expected: GatewayMapping, actual: GatewayMapping | undefined): Check[] {
  if (!actual) return [{ label: "mapping", expected: "valid", actual: "缺失", ok: false }];
  const out: Check[] = [];
  const creq = actual.create.request;
  const qreq = actual.query?.request;
  const nreq = actual.notify.request;

  out.push(check("create.method", expected.create.request.method ?? "POST", creq.method ?? "POST"));
  out.push(check("create.path", expected.create.request.path, creq.path));
  out.push(check("create.format", expected.create.request.format ?? "form", creq.format ?? "form"));
  out.push(check("query.method", expected.query?.request.method ?? "POST", qreq?.method ?? "POST"));
  out.push(check("query.path", expected.query?.request.path ?? "", qreq?.path ?? ""));
  out.push(check("query.format", expected.query?.request.format ?? "form", qreq?.format ?? "form"));

  for (const role of ["merchant", "order_no", "amount", "subject", "notify_url", "channel"] as const) {
    const exp = fieldOf(expected, role);
    if (exp === "（无）") continue;
    out.push(check(`create.field.${role}`, exp, fieldOf(actual, role)));
  }
  out.push(check("amount.unit.create", amountUnit(expected, "create"), amountUnit(actual, "create")));
  out.push(check("amount.unit.notify", amountUnit(expected, "notify"), amountUnit(actual, "notify")));
  out.push(check("amount.unit.query", amountUnit(expected, "query"), amountUnit(actual, "query")));

  out.push(check("create.sign.algo", expected.create.request.sign.algo ?? "md5", creq.sign?.algo ?? "md5"));
  out.push(
    check(
      "create.sign.key_append",
      expected.create.request.sign.key_append ?? "",
      creq.sign?.key_append ?? "",
    ),
  );
  out.push(check("create.response.ok", whenText(expected.create.response.ok), whenText(actual.create.response.ok)));
  out.push(check("notify.paid_when", whenText(expected.notify.request.paid_when), whenText(nreq.paid_when)));
  out.push(check("query.paid_when", whenText(expected.query?.response.paid_when), whenText(actual.query?.response.paid_when)));
  out.push(check("query.terminal_when", whenText(expected.query?.response.terminal_when), whenText(actual.query?.response.terminal_when), true));
  out.push(
    check(
      "notify.reply",
      expected.notify.response.reply,
      actual.notify.response.reply,
      false,
      true,
    ),
  );

  const expectedPayUrl = expected.create.response.fields.find((f) => f.role === "pay_url")?.field ?? "";
  const actualPayUrls = actual.create.response.fields.filter((f) => f.role === "pay_url").map((f) => f.field);
  out.push(check("create.pay_url", expectedPayUrl, actualPayUrls.join(" / ") || "（无）"));

  const expectedSign = expected.create.response.sign
    ? `${expected.create.response.sign.field}|${expected.create.response.sign.data_path ?? ""}`
    : "（无）";
  const actualSign = actual.create.response.sign
    ? `${actual.create.response.sign.field}|${actual.create.response.sign.data_path ?? ""}`
    : "（无）";
  out.push(check("create.response.sign", expectedSign, actualSign, true));

  const expectedQuerySign = expected.query?.response.sign
    ? `${expected.query.response.sign.field}|${expected.query.response.sign.data_path ?? ""}`
    : "（无）";
  const actualQuerySign = actual.query?.response.sign
    ? `${actual.query.response.sign.field}|${actual.query.response.sign.data_path ?? ""}`
    : "（无）";
  out.push(check("query.response.sign", expectedQuerySign, actualQuerySign, true));

  // name 只用于报告可读性
  out.push(check("sample", name, name));
  return out;
}

async function login(): Promise<string> {
  if (process.env.AI_EVAL_COOKIE) return process.env.AI_EVAL_COOKIE;
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-crm-request": "1" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(`本地登录失败（${res.status} ${body.error ?? ""}）；先 npm run dev:local，或用 AI_EVAL_EMAIL/PASSWORD 覆盖`);
  }
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("登录成功但没有 set-cookie");
  return cookie;
}

async function loadDocs(): Promise<{ qwgua: string; yihong: string; prague: string; xarrpay: string | null }> {
  const read = async (file: string): Promise<string> => {
    const raw = await readFile(path.join(DOCS_DIR, file), "utf8");
    const result = readAiDocument(file, raw);
    if (result.error) throw new Error(`${file}: ${result.error}`);
    return result.text;
  };
  const qwgua = await read("泡泡支付 - 运营管理系统.mhtml");
  const yihong = await read("亿宏数码API接口文档.html");
  const prague = await read("Api文档 - 布拉格.mhtml");
  let xarrpay: string | null = null;
  try {
    const file = process.env.AI_EVAL_XARRPAY_FILE;
    if (file) {
      const raw = await readFile(file, "utf8");
      const result = readAiDocument(file, raw);
      if (result.error) throw new Error(result.error);
      xarrpay = result.text;
    } else {
      const res = await fetch(XARR_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.text();
      const result = readAiDocument("xarrpay.html", raw);
      if (result.error) throw new Error(result.error);
      xarrpay = result.text;
    }
  } catch (error) {
    console.warn(`[ai-eval] XArrPay 文档获取失败，跳过该样本：${String(error)}`);
  }
  return { qwgua, yihong, prague, xarrpay };
}

describe.skipIf(!ENABLED)("AI 配置助手四家样本评测", () => {
  it("生成并输出可对比报告（不因语义差异失败）", async () => {
    const docs = await loadDocs();
    const cookie = await login();
    const cases: { name: string; expected: GatewayMapping; document: string }[] = [
      { name: "QWGUA", expected: QWGUA_MAPPING, document: docs.qwgua },
      { name: "亿宏", expected: YIHONG_MAPPING, document: docs.yihong },
      { name: "布拉格", expected: PRAGUE_MAPPING, document: docs.prague },
    ];
    if (docs.xarrpay) {
      cases.push({ name: "XArrPay", expected: XARRPAY_NATIVE_MAPPING, document: docs.xarrpay });
    }

    const samples: Sample[] = [];
    for (const item of cases) {
      const started = Date.now();
      const res = await fetch(`${BASE}/api/admin/gateways/ai-draft`, {
        method: "POST",
        headers: {
          cookie,
          "x-crm-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ document: item.document }),
      });
      const body = (await res.json().catch(() => ({}))) as EvalBody;
      const actual = body.draft?.template?.mapping;
      const checks = compare(item.name, item.expected, actual);
      samples.push({
        name: item.name,
        expected: item.expected,
        document: item.document,
        http: res.status,
        body,
        ms: Date.now() - started,
        checks,
        schema: Boolean(actual) && validateMapping(actual).ok,
      });
      if (res.status !== 200) {
        console.warn(`[ai-eval] ${item.name} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      }
    }
    expect(samples.some((s) => s.http === 200), "所有样本都没有返回 200").toBe(true);

    const report = samples.map((sample) => {
      const required = sample.checks.filter((c) => c.label !== "sample" && !c.optional);
      const passed = required.filter((c) => c.ok).length;
      const diffs = sample.checks
        .filter((c) => c.label !== "sample" && !c.ok)
        .map((c) => `${c.label}: ${c.actual} ≠ ${c.expected}`);
      return {
        name: sample.name,
        http: sample.http,
        classification: sample.body.draft?.classification ?? "（无）",
        error: sample.body.error ?? null,
        attempts: sample.body.attempts ?? 1,
        gate: sample.body.gate?.status ?? "（无）",
        warnings: sample.body.gate?.warnings ?? [],
        schema: sample.schema,
        matched: `${passed}/${required.length}`,
        diffs,
        ms: sample.ms,
      };
    });

    console.table(report.map(({ warnings: _warnings, diffs: _diffs, ...rest }) => rest));
    for (const row of report) {
      console.log(`\n### ${row.name} · gate=${row.gate} · ${row.matched} · ${row.ms}ms`);
      for (const w of row.warnings) console.log(`  warning: ${w}`);
      for (const d of row.diffs) console.log(`  diff: ${d}`);
    }

    const out = process.env.AI_EVAL_OUT ?? "/tmp/ai-eval-report.json";
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), report }, null, 2)),
    );
    console.log(`\n[ai-eval] 报告已写入 ${out}`);
  }, 240_000);
});
