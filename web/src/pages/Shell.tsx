import { useEffect, useState } from "react";
import { api, type Me } from "../api";
import Plans from "./Plans";
import Settings from "./Settings";

interface NavItem {
  href: string;
  label: string;
}

const NAV: NavItem[] = [
  { href: "/admin/", label: "概览" },
  { href: "/admin/customers", label: "客户" },
  { href: "/admin/orders", label: "订单" },
  { href: "/admin/plans", label: "套餐" },
  { href: "/admin/settings", label: "设置" },
];

function usePathname(): [string, (href: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (href: string) => {
    window.history.pushState(null, "", href);
    setPath(window.location.pathname);
  };
  return [path, navigate];
}

const PLACEHOLDERS: Record<string, string> = {
  "/admin/customers": "客户列表 / 详情 / 时间线 / 改控制参数",
  "/admin/orders": "订单状态机 / 退款 / 人工补单 / 对账",
};

export default function Shell({
  me,
  onLoggedOut,
  onMeChanged,
}: {
  me: Me;
  onLoggedOut: () => void;
  onMeChanged: (me: Me) => void;
}) {
  const [path, navigate] = usePathname();
  const current = NAV.find((item) => item.href === path) ?? NAV[0]!;

  async function logout() {
    await api.logout().catch(() => undefined);
    onLoggedOut();
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          CRM 管理后台
          <small>租户运营控制台</small>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={item.href === current.href ? "active" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.href);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <footer>{me.email}</footer>
      </aside>

      <div className="main">
        <header className="topbar">
          <h2>{current.label}</h2>
          <button onClick={logout}>退出登录</button>
        </header>
        <div className="content">
          {path === "/admin/settings" ? (
            <Settings me={me} onMeChanged={onMeChanged} />
          ) : path === "/admin/plans" ? (
            <Plans />
          ) : path === "/admin/" ? (
            <div className="card">
              <h3>概览</h3>
              <p className="hint">
                这里将展示今日注册 / 今日收入 / 待处理订单 / 即将到期客户。
                数据来自订单与 cf-api 客户镜像，待业务接口落地后接入。
              </p>
              <div className="empty">业务模块尚未实现</div>
            </div>
          ) : (
            <div className="card">
              <h3>{current.label}</h3>
              <p className="hint">{PLACEHOLDERS[path] ?? "待实现"}</p>
              <div className="empty">业务模块尚未实现</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
