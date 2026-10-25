#!/usr/bin/env node
/**
 * 本地联调用的**假 cf-api**（只在开发机跑，绝不部署）。
 *
 * 为什么需要它：CRM 的落账失败时会**如实**停在 `provisioning`（这是契约行为），
 * 所以本地没有 cf-api 时，付完款也拿不到激活码，`app-web` 就看不到完整链路。
 *
 * 实现范围：只做 CRM 真正会调的四个动作（`crm-api.md` §3.1）——
 *   GET    /api/v1/customers?filters[auth_id][$eq]=…
 *   POST   /api/v1/customers
 *   GET    /api/v1/customers/:id
 *   PATCH  /api/v1/customers/:id     （licence_limit 不可改，静默丢弃）
 *   DELETE /api/v1/customers/:id     （软删）
 *
 * 用法：
 *   node scripts/fake-cf-api.mjs            # 监听 127.0.0.1:8899
 *   然后在 .dev.vars 里加：
 *     CF_API_BASE=http://127.0.0.1:8899
 *     CF_API_TOKEN=cv_api_local
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8899);
const TOKEN = process.env.FAKE_TOKEN ?? "cv_api_local";
const GIGA = 1024 ** 3;

/** id → customer */
const db = new Map();
let idSeq = 4200;
let codeSeq = 7391048261558200;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** 让日志直接看得出"字节对不对" */
function describe(c) {
  const gb = c.traffic_balance === null ? "不限量" : `${(c.traffic_balance / GIGA).toFixed(2)} GB`;
  return `id=${c.id} code=${c.code} auth_id=${c.auth_id} limit=${c.licence_limit} frozen=${c.frozen} ` +
    `expire=${c.expire_date ?? "—"} traffic=${gb} quota=${c.quota === null ? "NULL" : c.quota}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/health") return send(res, 200, { ok: true, customers: db.size });
  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }

  const match = url.pathname.match(/^\/api\/v1\/customers(?:\/(\d+))?$/);
  if (!match) return send(res, 404, { error: "not found" });

  const id = match[1] ? Number(match[1]) : null;
  const method = (req.method ?? "GET").toUpperCase();

  // 列表 / 按 auth_id 查
  if (method === "GET" && id === null) {
    const authId = url.searchParams.get("filters[auth_id][$eq]");
    const items = [...db.values()].filter(
      (c) => c._is_deleted === 0 && (authId === null || c.auth_id === authId),
    );
    return send(res, 200, { items, total: items.length });
  }

  if (method === "POST") {
    const body = await readJson(req);
    const authId = String(body.auth_id ?? "");
    if (authId && [...db.values()].some((c) => c._is_deleted === 0 && c.auth_id === authId)) {
      return send(res, 409, { error: `auth_id_conflict: ${authId}` });
    }
    idSeq += 1;
    codeSeq += 1;
    const created = {
      id: idSeq,
      code: String(codeSeq),
      name: body.name ?? "",
      email: body.email ?? null,
      auth_id: authId,
      licence_limit: Number(body.licence_limit ?? 1),
      frozen: Number(body.frozen ?? 0),
      expire_date: body.expire_date ?? null,
      traffic_balance: body.traffic_balance ?? null,
      quota: body.quota ?? null,
      up_mbps: body.up_mbps ?? null,
      down_mbps: body.down_mbps ?? null,
      _is_deleted: 0,
    };
    db.set(created.id, created);
    console.log(`[fake-cf] CREATE ${describe(created)}`);
    return send(res, 201, created);
  }

  if (id === null) return send(res, 404, { error: "not found" });
  const current = db.get(id);
  if (!current || current._is_deleted === 1) return send(res, 404, { error: "not found" });

  if (method === "GET") return send(res, 200, current);

  if (method === "PATCH") {
    const body = await readJson(req);
    const next = {
      ...current,
      // licence_limit 不在 allow-list：平台**静默丢弃**（crm-api.md §3.2）
      frozen: Number(body.frozen ?? current.frozen),
      expire_date: body.expire_date ?? null,
      traffic_balance: body.traffic_balance ?? null,
      quota: body.quota ?? null,
      up_mbps: body.up_mbps ?? current.up_mbps,
      down_mbps: body.down_mbps ?? current.down_mbps,
    };
    db.set(id, next);
    console.log(`[fake-cf] PATCH  ${describe(next)}`);
    return send(res, 200, next);
  }

  if (method === "DELETE") {
    db.set(id, { ...current, _is_deleted: 1 });
    console.log(`[fake-cf] DELETE id=${id}（旧 code 失效）`);
    return send(res, 200, { success: true });
  }

  return send(res, 405, { error: "method not allowed" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-cf] listening on http://127.0.0.1:${PORT}  token=${TOKEN}`);
  console.log("[fake-cf] 在 .dev.vars 里配置 CF_API_BASE / CF_API_TOKEN 后重启 wrangler dev");
});
