import { useEffect, useState } from "react";
import {
  Avatar,
  Breadcrumb,
  Dropdown,
  Grid,
  Layout,
  Menu,
  Tag,
  Typography,
  theme as antdTheme,
} from "antd";
import {
  AppstoreOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  FileTextOutlined,
  LogoutOutlined,
  InboxOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { api, type Me } from "../api";
import Gateways from "./Gateways";
import Plans from "./Plans";
import Settings from "./Settings";

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: React.ReactNode;
}

/** 侧栏只放这六项：少而稳，不往里堆二级菜单 */
const NAV: NavItem[] = [
  { key: "/admin/", href: "/admin/", label: "概览", icon: <DashboardOutlined /> },
  { key: "/admin/customers", href: "/admin/customers", label: "客户", icon: <TeamOutlined /> },
  { key: "/admin/orders", href: "/admin/orders", label: "订单", icon: <FileTextOutlined /> },
  { key: "/admin/plans", href: "/admin/plans", label: "套餐", icon: <AppstoreOutlined /> },
  { key: "/admin/gateways", href: "/admin/gateways", label: "支付", icon: <CreditCardOutlined /> },
  { key: "/admin/settings", href: "/admin/settings", label: "设置", icon: <SettingOutlined /> },
];

const PLACEHOLDERS: Record<string, string> = {
  "/admin/": "今日注册 / 今日收入 / 待处理订单 / 即将到期客户 —— 数据来自订单与 cf-api 客户镜像。",
  "/admin/customers": "客户列表 / 详情 / 订阅历史 / 改控制参数。",
  "/admin/orders": "订单状态机 / 退款 / 人工补单 / 对账。",
};

function usePathname(): [string, (href: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (href: string) => {
    if (href === window.location.pathname) return;
    window.history.pushState(null, "", href);
    setPath(window.location.pathname);
  };
  return [path, navigate];
}

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
  const screens = Grid.useBreakpoint();
  // 首帧 screens 是空对象（还不知道宽度）：用 md === false 判断"确认是小屏"，
  // 否则会在手机上先闪一下侧栏。
  const isMobile = screens.md === false;
  const { token } = antdTheme.useToken();
  const current = NAV.find((item) => item.href === path) ?? NAV[0]!;

  async function logout() {
    await api.logout().catch(() => undefined);
    onLoggedOut();
  }

  const page =
    path === "/admin/settings" ? (
      <Settings me={me} onMeChanged={onMeChanged} />
    ) : path === "/admin/plans" ? (
      <Plans />
    ) : path === "/admin/gateways" ? (
      <Gateways />
    ) : (
      <Placeholder title={current.label} hint={PLACEHOLDERS[path] ?? "待实现"} />
    );

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {!isMobile && (
        <Layout.Sider
          width={208}
          theme="dark"
          style={{ position: "sticky", top: 0, height: "100vh" }}
        >
          <Brand />
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[current.key]}
            items={NAV.map((n) => ({ key: n.key, icon: n.icon, label: n.label }))}
            onClick={({ key }) => navigate(key)}
            style={{ borderInlineEnd: "none" }}
          />
          <div style={{ position: "absolute", bottom: 16, left: 16, right: 16 }}>
            <Tag
              color={me.mail_ready ? "success" : "warning"}
              style={{ width: "100%", textAlign: "center", marginInlineEnd: 0 }}
            >
              {me.mail_ready ? "邮件通道已就绪" : "邮件通道未配置"}
            </Tag>
          </div>
        </Layout.Sider>
      )}

      <Layout>
        <Layout.Header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {isMobile ? (
            <Typography.Text strong style={{ fontSize: 16 }}>
              {current.label}
            </Typography.Text>
          ) : (
            <Breadcrumb
              items={[{ title: "控制台" }, { title: current.label }]}
              style={{ fontSize: 13 }}
            />
          )}

          <Dropdown
            placement="bottomRight"
            menu={{
              items: [
                { key: "settings", icon: <SettingOutlined />, label: "设置" },
                { type: "divider" },
                { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true },
              ],
              onClick: ({ key }) => (key === "logout" ? void logout() : navigate("/admin/settings")),
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <Avatar
                size={30}
                style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}
              >
                {me.email.slice(0, 1).toUpperCase()}
              </Avatar>
              {!isMobile && (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {me.email}
                </Typography.Text>
              )}
            </div>
          </Dropdown>
        </Layout.Header>

        <Layout.Content
          style={{
            // 手机底部有 Tab 栏，留出安全区
            padding: isMobile ? "16px 16px 88px" : 24,
            maxWidth: 1280,
            width: "100%",
            margin: "0 auto",
          }}
        >
          {page}
        </Layout.Content>
      </Layout>

      {/* 手机端导航：底部 Tab 栏（拇指可达，切换零成本） */}
      {isMobile && (
        <nav
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 30,
            display: "grid",
            gridTemplateColumns: `repeat(${NAV.length}, 1fr)`,
            background: token.colorBgContainer,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {NAV.map((item) => {
            const active = item.key === current.key;
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.href)}
                style={{
                  border: 0,
                  background: "transparent",
                  padding: "8px 0 10px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                  fontSize: 11,
                  cursor: "pointer",
                  color: active ? token.colorPrimary : token.colorTextTertiary,
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>
      )}
    </Layout>
  );
}

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 20px 22px" }}>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontWeight: 700,
          fontSize: 12,
          background: "linear-gradient(135deg, #6d4aff, #b06bff)",
        }}
      >
        CV
      </span>
      <span style={{ color: "#fff", fontWeight: 600, fontSize: 15, lineHeight: 1.2 }}>
        Clever VPN
        <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "#8b96ac" }}>
          运营控制台
        </span>
      </span>
    </div>
  );
}

function Placeholder({ title, hint }: { title: string; hint: string }) {
  const { token } = antdTheme.useToken();
  return (
    <div
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: 24,
      }}
    >
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
        {hint}
      </Typography.Paragraph>
      <div style={{ textAlign: "center", color: token.colorTextQuaternary, padding: "32px 0" }}>
        <InboxOutlined style={{ fontSize: 28, display: "block", marginBottom: 8 }} />
        业务模块尚未实现
      </div>
    </div>
  );
}
