/**
 * 签名密钥的唯一取法。
 *
 * 只有一处取法，没有回退：散落在各调用点会让"到底用哪个"变成谜。
 * 名字叫 signing 而不是 session —— 它签的是**一次性证明**（退订链接、webhook 回调），
 * 不是登录态（登录态是 `app_sessions` 里的随机 token + 查表，不涉及密钥）。
 */
import type { Env } from "./env";

/** 空串表示"没配"——调用方必须把它当成"功能不可用"，而不是"用空密钥签" */
export function signingKeyOf(env: Env): string {
  return String(env.SIGNING_SECRET ?? "").trim();
}
