/**
 * @deprecated 直接用 `src/secrets.ts` 的 `signingKeyOf`。
 *
 * 这里只是历史入口：签名密钥不再单独配（`SIGNING_SECRET` 已并入 `APP_SECRET`），
 * 派生逻辑集中在 `src/secrets.ts`。
 */
export { signingKeyOf } from "./secrets";
