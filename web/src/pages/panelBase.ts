/**
 * 面板的挂载前缀。
 *
 * - 默认（SaaS / 独立域名）：空 —— 入口就是 `/`。CRM 有自己的域名，多一层
 *   `/admin` 只是让人记一个不该存在的前缀。
 * - 自托管把官网放在根路径时（配了 `SITE_URL`），后台挂在 `/admin` 下，
 *   Worker 不会把 `/admin/*` 302 走，前缀因此要保留。
 *
 * 前缀由**首次加载的地址**决定，一次加载内不变，前端只需拼接。
 * 单独成文件是为了让 `Marketing.tsx` 之类的页面也能拼，而不必反向 import
 * `Shell.tsx`（会形成循环依赖）。
 */
export const PANEL_BASE = window.location.pathname.startsWith("/admin")
  ? "/admin"
  : "";

/** `/admin/plans` → `/plans`；不带前缀时原样返回 */
export function stripPanelBase(pathname: string): string {
  if (!PANEL_BASE || !pathname.startsWith(PANEL_BASE)) return pathname || "/";
  const rest = pathname.slice(PANEL_BASE.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}
