/**
 * 面板路由判定（纯函数，便于单测）
 *
 * CRM 有自己的域名：**入口就是 `/`**，不该让人记一层 `/admin`。`/admin/*` 只留
 * 302 兼容旧书签与邮件链接。
 *
 * 单独抽出来是因为这条规则必须在**纯函数层面**被测住：Worker 集成测试跑在
 * workerd 里，`assets` 层会把 `/admin`、`/admin/plans` 这类路径直接当成静态
 * 命中先答掉，Worker 根本收不到 —— 在那里断言 302 等于测静态资源，测不到这里。
 */

/** 有一个文件扩展名（`/admin/assets/index-abc.js`）—— 真文件，不参与 SPA 回落 */
export function looksLikeFile(pathname: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(pathname);
}

/** `/admin/plans` → `/plans`，`/admin/` 与 `/admin` → `/` */
export function stripAdminPrefix(pathname: string): string {
  const rest = pathname.slice("/admin".length);
  if (!rest || rest === "/") return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

export type PanelRoute =
  /** 根路径归官网（自托管配了 `SITE_URL`） */
  | { kind: "site"; to: string }
  /** 交后台 SPA 的 index.html */
  | { kind: "spa" }
  /** 302 到面板里的规范路径 */
  | { kind: "redirect"; to: string }
  /** 交给静态资源 / 正常处理 */
  | { kind: "pass" };

/**
 * @param pathname 请求路径
 * @param siteUrl  `env.SITE_URL`（可能为空串或 undefined）
 */
export function panelRoute(pathname: string, siteUrl: string | undefined): PanelRoute {
  const site = (siteUrl ?? "").trim();

  // 根路径：配了 SITE_URL 就归官网（此时面板留在 `/admin/`，两边不抢 `/`）；
  // 否则根路径就是面板入口。
  if (pathname === "/" || pathname === "/index.html") {
    return site ? { kind: "site", to: site } : { kind: "spa" };
  }

  // 老地址 → 新地址。真文件不参与（`admin/assets/*` 是构建产物目录）。
  if (
    !site &&
    (pathname === "/admin" || (pathname.startsWith("/admin/") && !looksLikeFile(pathname)))
  ) {
    return { kind: "redirect", to: stripAdminPrefix(pathname) };
  }

  return { kind: "pass" };
}

/** 深链接（`/plans`、`/settings`…）要不要回落到 index.html */
export function isSpaDeepLink(pathname: string): boolean {
  return !looksLikeFile(pathname);
}
