/**
 * 面板内导航 + 未保存拦截。
 *
 * Shell 的 `usePathname` 监听 `popstate`/`crm:navigate`；页面只调 `navigate()`，
 * 不直接碰 history。编辑器注册 `setNavGuard`，列表/侧栏/面包屑都走同一道闸。
 */
import { PANEL_BASE } from "./pages/panelBase";

let guard: (() => boolean) | null = null;

/** 注册导航守卫；返回的函数用于卸载时清理 */
export function setNavGuard(fn: () => boolean): () => void {
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}

/** 当前是否允许离开（没有守卫 = 允许） */
export function canNavigate(): boolean {
  return !guard || guard();
}

export function navigate(href: string): void {
  if (!canNavigate()) return;
  const target = PANEL_BASE + href;
  if (window.location.pathname === target) return;
  window.history.pushState(null, "", target);
  window.dispatchEvent(new Event("crm:navigate"));
}

export type GatewayRoute =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "edit"; id: number };

/** `/payments/gateways`、`/new`、`/:id/edit`；其它返回 null */
export function parseGatewayRoute(path: string): GatewayRoute | null {
  if (path === "/payments/gateways" || path === "/payments/gateways/") return { kind: "list" };
  if (path === "/payments/gateways/new") return { kind: "new" };
  const m = /^\/payments\/gateways\/(\d+)\/edit$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    if (Number.isSafeInteger(id) && id > 0) return { kind: "edit", id };
  }
  return null;
}

export const GATEWAY_LIST_PATH = "/payments/gateways";
