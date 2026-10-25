import { useEffect, useState } from "react";
import {
  Avatar,
  Breadcrumb,
  Button,
  Drawer,
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
  GiftOutlined,
  LogoutOutlined,
  InboxOutlined,
  MenuOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { api, type Me } from "../api";
import ComingSoon from "./ComingSoon";
import Customers from "./Customers";
import Gateways from "./Gateways";
import Marketing from "./Marketing";
import Orders from "./Orders";
import Plans from "./Plans";
import Promotions from "./Promotions";
import Settings from "./Settings";

interface NavLeaf {
  key: string;
  href: string;
  label: string;
}

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** 叶子节点才有 href；有 children 的就是分组 */
  href?: string;
  children?: NavLeaf[];
}

/**
 * 侧栏：一级栏目少而稳；「营销」是一个分组，子项直接可点（一次点到位）。
 * 早期这里写死“只放六项”，现在已经放开 —— 以“用户能不能一步到达”为准。
 */
const NAV: NavItem[] = [
  { key: "/admin/", href: "/admin/", label: "概览", icon: <DashboardOutlined /> },
  { key: "/admin/customers", href: "/admin/customers", label: "客户", icon: <TeamOutlined /> },
  { key: "/admin/orders", href: "/admin/orders", label: "订单", icon: <FileTextOutlined /> },
  { key: "/admin/plans", href: "/admin/plans", label: "套餐", icon: <AppstoreOutlined /> },
  { key: "/admin/gateways", href: "/admin/gateways", label: "支付", icon: <CreditCardOutlined /> },
  {
    key: "/admin/marketing",
    label: "营销",
    icon: <GiftOutlined />,
    children: [
      { key: "/admin/marketing/overview", href: "/admin/marketing/overview", label: "营销总览" },
      { key: "/admin/marketing/coupons", href: "/admin/marketing/coupons", label: "优惠券" },
      { key: "/admin/marketing/gifts", href: "/admin/marketing/gifts", label: "礼包" },
      { key: "/admin/marketing/referrals", href: "/admin/marketing/referrals", label: "邀请返利" },
      { key: "/admin/marketing/report", href: "/admin/marketing/report", label: "营销报表" },
    ],
  },
  { key: "/admin/settings", href: "/admin/settings", label: "设置", icon: <SettingOutlined /> },
];

/** 所有可点节点（分组本身不可点）——面包屑、选中态、手机 Tab 都靠它 */
const LEAVES: NavLeaf[] = NAV.flatMap((n) => (n.children ? n.children : [{ key: n.key, href: n.href!, label: n.label }]));

/** antd Menu / Drawer 共用同一份 items（含 SubMenu） */
const MENU_ITEMS = NAV.map((n) =>
  n.children
    ? {
        key: n.key,
        icon: n.icon,
        label: n.label,
        children: n.children.map((c) => ({ key: c.key, label: c.label })),
      }
    : { key: n.key, icon: n.icon, label: n.label },
);

/** 营销分组默认展开：分类存在的意义是“一眼看全”，不该先让人再点一次 */
const DEFAULT_OPEN_KEYS = ["/admin/marketing"];

/**
 * 手机底部标签栏只放"每天要点"的入口（Material / iOS 规范：3–5 个）。
 * 其余导航全部进左上角抽屉 —— 以后加功能不用再挤这里。
 */
const MOBILE_TABS = NAV.filter((n): n is NavItem & { href: string } => Boolean(n.href)).slice(0, 3);

const PLACEHOLDERS: Record<string, string> = {
  "/admin/": "今日注册 / 今日收入 / 待处理订单 / 即将到期客户 —— 数据来自订单与 cf-api 客户镜像。",
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  // 首帧 screens 是空对象（还不知道宽度）：用 md === false 判断"确认是小屏"，
  // 否则会在手机上先闪一下侧栏。
  const isMobile = screens.md === false;
  const { token } = antdTheme.useToken();
  const current = LEAVES.find((item) => item.href === path) ?? LEAVES[0]!;

  async function logout() {
    await api.logout().catch(() => undefined);
    onLoggedOut();
  }

  const page =
    path === "/admin/settings" ? (
      <Settings me={me} onMeChanged={onMeChanged} />
    ) : path === "/admin/customers" ? (
      <Customers />
    ) : path === "/admin/orders" ? (
      <Orders />
    ) : path === "/admin/plans" ? (
      <Plans />
    ) : path === "/admin/gateways" ? (
      <Gateways />
    ) : path === "/admin/marketing/overview" ? (
      <Marketing />
    ) : path === "/admin/marketing/coupons" ? (
      <Promotions kind="coupon" />
    ) : path === "/admin/marketing/referrals" ? (
      <Promotions kind="referral" />
    ) : path === "/admin/marketing/gifts" ? (
      <Promotions kind="gift" />
    ) : path === "/admin/marketing/report" ? (
      <ComingSoon
        title="营销报表"
        stage="P3（核销台账已有，只差聚合）"
        intro="哪个活动在赚钱、哪个在烧钱。没有这张表，促销就是盲投。"
        bullets={[
          "按活动看：核销次数、带动订单数、实收金额、让利金额",
          "新客占比 / 续费占比（按订单发生时该客户有没有付过钱判定）",
          "退款把核销标记为作废，名额是否返还由活动配置决定",
        ]}
      />
    ) : (
      <Placeholder title={current.label} hint={PLACEHOLDERS[path] ?? "待实现"} />
    );

  return (
    <>
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
            defaultOpenKeys={DEFAULT_OPEN_KEYS}
            items={MENU_ITEMS}
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
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Button
                type="text"
                icon={<MenuOutlined />}
                aria-label="打开菜单"
                onClick={() => setDrawerOpen(true)}
                style={{ marginInlineStart: -6 }}
              />
              <Typography.Text strong style={{ fontSize: 16 }}>
                {current.label}
              </Typography.Text>
            </div>
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
            // 高频入口 + 一个「更多」（打开抽屉）—— 以后加功能只进抽屉，不动这里
            gridTemplateColumns: `repeat(${MOBILE_TABS.length + 1}, 1fr)`,
            background: token.colorBgContainer,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {MOBILE_TABS.map((item) => {
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
          <button
            onClick={() => setDrawerOpen(true)}
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
              // 当前页不在底部这四项里 ⇒ 高亮"更多"，告诉用户它在抽屉里
              color: MOBILE_TABS.some((t) => t.key === current.key)
                ? token.colorTextTertiary
                : token.colorPrimary,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>
              <MenuOutlined />
            </span>
            更多
          </button>
        </nav>
      )}

      {/*
        手机端导航分两层（业界标准）：
          · 底部标签栏 = 每天要点的高频入口（MOBILE_TABS，3 个 + 「更多」）
          · 左上角汉堡 → 抽屉 = **全部**导航，以后加功能不用再挤底部
      */}
      <Drawer
        placement="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={260}
        title={<Brand />}
        styles={{ header: { padding: 0, borderBottom: "none" }, body: { padding: 0 } }}
      >
        <Menu
          mode="inline"
          selectedKeys={[current.key]}
          defaultOpenKeys={DEFAULT_OPEN_KEYS}
          items={MENU_ITEMS}
          onClick={({ key }) => {
            setDrawerOpen(false);
            navigate(key);
          }}
          style={{ borderInlineEnd: "none" }}
        />
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <Tag
            color={me.mail_ready ? "success" : "warning"}
            style={{ width: "100%", textAlign: "center", marginInlineEnd: 0 }}
          >
            {me.mail_ready ? "邮件通道已就绪" : "邮件通道未配置"}
          </Tag>
          <Button block icon={<LogoutOutlined />} danger onClick={() => void logout()}>
            退出登录
          </Button>
        </div>
      </Drawer>
      </Layout>
    </>
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
