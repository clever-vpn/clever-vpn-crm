/**
 * 退订营销类通知
 *
 * 三条设计约束（每一条都有代价高昂的反例）：
 *   1. **不需要登录** —— 收不到信的人往往也登不进来，要求登录等于没给退订；
 *      所以用签名链接（`customer_id` + HMAC），不存一次性票据，也就不需要清理。
 *   2. **只退营销类** —— 验证码 / 订单结果不退订：App 是无密码登录，
 *      退掉验证码等于关掉这个账号。
 *   3. **支持一键退订** —— 邮件里带 `List-Unsubscribe` + `List-Unsubscribe-Post`，
 *      邮件客户端的"退订"按钮会直接 POST（body 是 `List-Unsubscribe=One-Click`），
 *      不需要用户点开网页再确认一次。
 */
import type { Env } from "../env";

/** 没有 `SITE_URL`（本地/未配官网）就生成不出绝对链接，邮件里就不放退订入口 */
function siteBase(env: Env): string {
  return (env.SITE_URL ?? "").trim().replace(/\/$/, "");
}

function secret(env: Env): string {
  return env.SESSION_SECRET ?? "";
}

/** HMAC-SHA256(secret, `unsub:{customerId}`) 的十六进制前 32 位 */
async function token(env: Env, customerId: number): Promise<string | null> {
  const key = secret(env);
  if (!key) return null;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(`unsub:${customerId}`));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** 幂等比较：长度不同也走完整比较，避免按长度泄露信息 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 邮件里的退订链接；配不全就返回 null（发送器会因此省掉退订头） */
export async function unsubscribeUrl(env: Env, customerId: number): Promise<string | null> {
  const base = siteBase(env);
  const t = await token(env, customerId);
  if (!base || !t) return null;
  return `${base}/unsubscribe?c=${customerId}&t=${t}`;
}

export async function verifyUnsubscribeToken(
  env: Env,
  customerId: number,
  provided: string,
): Promise<boolean> {
  const expected = await token(env, customerId);
  if (!expected) return false;
  return safeEqual(expected, provided);
}

/** 退订营销类通知（幂等） */
export async function optOutMarketing(env: Env, customerId: number): Promise<void> {
  await env.DB.prepare(`UPDATE customers SET marketing_opt_out = 1 WHERE id = ?`)
    .bind(customerId)
    .run();
  // 顺手把还没发出去的营销通知置为 skipped：不置的话它们会在下一轮继续被泵取到
  await env.DB.prepare(
    `UPDATE notices SET status = 'skipped'
      WHERE customer_id = ? AND status = 'pending' AND kind IN ('gift_claim', 'gift_auto')`,
  )
    .bind(customerId)
    .run();
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>退订通知</title>
<div style="font:16px/1.7 -apple-system,Segoe UI,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px">
${body}
</div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * `GET /unsubscribe?c=&t=` → 确认页；`POST` 同 URL → 执行退订（支持一键）。
 *
 * 注意：POST 不做 CSRF token 校验 —— 这个接口的效果是"少发营销邮件"，
 * 被冒用的最坏结果是自己退订，不是越权；而要求 token 会让邮件客户端的一键退订失效。
 */
export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const customerId = Number(url.searchParams.get("c"));
  const provided = url.searchParams.get("t") ?? "";

  if (!Number.isInteger(customerId) || customerId <= 0) {
    return html("<h2>链接无效</h2><p>这个退订链接不完整，请从邮件里重新打开。</p>", 400);
  }
  if (!(await verifyUnsubscribeToken(env, customerId, provided))) {
    return html(
      "<h2>链接已失效</h2><p>这个退订链接不正确。你可以直接回复邮件联系我们。</p>",
      400,
    );
  }

  if (request.method === "POST") {
    await optOutMarketing(env, customerId);
    return html(
      "<h2>已退订</h2><p>我们不会再给你发送礼包和活动通知。</p><p style='color:#6b7480;font-size:13px'>登录验证码、支付与开通结果不受影响。</p>",
    );
  }

  return html(`
    <h2>退订通知</h2>
    <p>退订后，我们不再给你发送礼包和活动通知（登录验证码与订单结果不受影响）。</p>
    <form method="post" action="/unsubscribe?c=${customerId}&t=${esc(provided)}">
      <button type="submit" style="background:#2563eb;color:#fff;border:0;padding:10px 18px;border-radius:6px;font-size:14px;cursor:pointer">确认退订</button>
    </form>
    <p style="color:#9aa3ad;font-size:12px;margin-top:24px">不想退订？直接关掉这个页面即可。</p>`);
}

/** 供测试/后台使用：把某人重新订阅（幂等） */
export async function optInMarketing(env: Env, customerId: number): Promise<void> {
  await env.DB.prepare(`UPDATE customers SET marketing_opt_out = 0 WHERE id = ?`)
    .bind(customerId)
    .run();
}
