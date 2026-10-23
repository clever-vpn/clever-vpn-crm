import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Col, Form, Input, Row, Segmented, Space, Typography } from "antd";
import {
  LockOutlined,
  MailOutlined,
  NumberOutlined,
  SafetyCertificateOutlined,
  ThunderboltFilled,
} from "@ant-design/icons";
import { ApiError, api, type Bootstrap } from "../api";
import Turnstile from "../Turnstile";

/**
 * 登录：密码 / 邮箱验证码两条路径。
 *
 * - 邮箱那条**只在服务端真能发信时才显示**（bootstrap.methods）——
 *   自托管没配邮件时这里只有密码，而不是给个点了报错的按钮。
 * - 版式：左品牌墙 + 右表单（手机下品牌墙收起，只留表单 + 顶部一条渐变）。
 */
export default function Login({ onDone }: { onDone: () => void | Promise<void> }) {
  const [stage, setStage] = useState<"password" | "totp">("password");
  const [mode, setMode] = useState<"password" | "email">("password");
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [devCode, setDevCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.bootstrap().then(setBoot).catch(() => setBoot(null));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const emailModeAvailable = Boolean(boot?.methods.includes("email"));
  const siteKey = boot?.turnstile_site_key ?? null;

  function failMessage(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.code === "turnstile_failed") {
      return "人机校验未通过，请刷新页面后重试";
    }
    return fallback;
  }

  async function sendEmailCode(email: string) {
    setBusy(true);
    setError("");
    setDevCode("");
    try {
      const res = await api.loginEmailStart(email, turnstileToken);
      setCooldown(res.cooldown ?? 60);
      if (res.code) setDevCode(res.code);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "email_unavailable"
          ? "服务端未配置邮件发送，请使用密码登录"
          : failMessage(err, "验证码发送失败，请稍后再试"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(values: { email: string; password: string }) {
    setBusy(true);
    setError("");
    try {
      const res = await api.login(values.email, values.password, turnstileToken);
      if (res.totp_required) setStage("totp");
      else await onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "locked"
          ? "尝试次数过多，请 15 分钟后再试"
          : err instanceof ApiError && err.code === "turnstile_failed"
            ? "人机校验未通过，请刷新页面后重试"
            : err instanceof ApiError && err.status === 401
              ? "邮箱或密码不正确"
              : "登录失败，请稍后再试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitEmailCode(values: { email: string; code: string }) {
    setBusy(true);
    setError("");
    try {
      const res = await api.loginEmailVerify(values.email, values.code);
      if (res.totp_required) setStage("totp");
      else await onDone();
    } catch {
      setError("验证码不正确或已过期");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(values: { code: string }) {
    setBusy(true);
    setError("");
    try {
      await api.loginTotp(values.code);
      await onDone();
    } catch {
      setError("验证码不正确或已过期");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row style={{ minHeight: "100vh", background: "#fff" }}>
      {/* 品牌墙：手机上隐藏（xs=0），平板以上占一半 */}
      <Col xs={0} md={12} lg={13}>
        <BrandWall />
      </Col>

      <Col xs={24} md={12} lg={11}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "32px 20px 48px",
          }}
        >
          <div style={{ width: "100%", maxWidth: 380 }}>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              {stage === "totp" ? "两步验证" : "登录"}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
              {stage === "totp"
                ? "输入认证器中的 6 位验证码。"
                : mode === "email"
                  ? "给管理员邮箱发一封 6 位验证码。"
                  : "单管理员账号，仅授权运营者使用。"}
            </Typography.Paragraph>

            {stage !== "totp" && emailModeAvailable && (
              <Segmented
                block
                value={mode}
                onChange={(v) => {
                  setMode(v as "password" | "email");
                  setError("");
                }}
                options={[
                  { label: "密码", value: "password" },
                  { label: "邮箱验证码", value: "email" },
                ]}
                style={{ marginBottom: 20 }}
              />
            )}

            {stage === "totp" ? (
              <TotpForm busy={busy} error={error} onSubmit={submitTotp} onBack={() => setStage("password")} />
            ) : mode === "password" ? (
              <>
                <PasswordForm busy={busy} onSubmit={submitPassword} />
                {siteKey && <Turnstile siteKey={siteKey} onToken={setTurnstileToken} />}
                {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
              </>
            ) : (
              <EmailForm
                busy={busy}
                cooldown={cooldown}
                devCode={devCode}
                error={error}
                siteKey={siteKey}
                onTurnstile={setTurnstileToken}
                onSend={sendEmailCode}
                onSubmit={submitEmailCode}
              />
            )}
          </div>
        </div>
      </Col>
    </Row>
  );
}

function PasswordForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (v: { email: string; password: string }) => void;
}) {
  return (
    <Form layout="vertical" size="large" requiredMark={false} onFinish={onSubmit}>
      <Form.Item
        name="email"
        rules={[{ required: true, message: "请输入邮箱" }]}
        style={{ marginBottom: 16 }}
      >
        <Input prefix={<MailOutlined />} placeholder="管理员邮箱" autoComplete="username" />
      </Form.Item>
      <Form.Item
        name="password"
        rules={[{ required: true, message: "请输入密码" }]}
        style={{ marginBottom: 12 }}
      >
        <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
      </Form.Item>
      <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 16 }}>
        <Checkbox defaultChecked>记住账号</Checkbox>
      </Form.Item>
      <Button type="primary" htmlType="submit" size="large" block loading={busy}>
        登录
      </Button>
    </Form>
  );
}

function EmailForm({
  busy,
  cooldown,
  devCode,
  error,
  siteKey,
  onTurnstile,
  onSend,
  onSubmit,
}: {
  busy: boolean;
  cooldown: number;
  devCode: string;
  error: string;
  siteKey: string | null;
  onTurnstile: (token: string) => void;
  onSend: (email: string) => void;
  onSubmit: (v: { email: string; code: string }) => void;
}) {
  const [form] = Form.useForm<{ email: string; code: string }>();
  return (
    <Form form={form} layout="vertical" size="large" requiredMark={false} onFinish={onSubmit}>
      <Form.Item
        name="email"
        rules={[{ required: true, message: "请输入邮箱" }]}
        style={{ marginBottom: 16 }}
      >
        <Input prefix={<MailOutlined />} placeholder="管理员邮箱" autoComplete="username" />
      </Form.Item>
      <Form.Item style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Form.Item name="code" noStyle rules={[{ required: true, message: "请输入验证码" }]}>
            <Input
              prefix={<NumberOutlined />}
              placeholder="6 位验证码"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
            />
          </Form.Item>
          <Button
            onClick={() => onSend(form.getFieldValue("email") ?? "")}
            disabled={busy || cooldown > 0}
          >
            {cooldown > 0 ? `${cooldown}s` : "发送验证码"}
          </Button>
        </Space.Compact>
      </Form.Item>

      {devCode && (
        <Alert
          type="success"
          showIcon
          message={`开发环境回显验证码：${devCode}`}
          style={{ marginBottom: 12 }}
        />
      )}
      {siteKey && <Turnstile siteKey={siteKey} onToken={onTurnstile} />}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      <Button type="primary" htmlType="submit" size="large" block loading={busy}>
        用验证码登录
      </Button>
    </Form>
  );
}

function TotpForm({
  busy,
  error,
  onSubmit,
  onBack,
}: {
  busy: boolean;
  error: string;
  onSubmit: (v: { code: string }) => void;
  onBack: () => void;
}) {
  return (
    <Form layout="vertical" size="large" requiredMark={false} onFinish={onSubmit}>
      <Form.Item name="code" rules={[{ required: true, message: "请输入验证码" }]}>
        <Input
          prefix={<SafetyCertificateOutlined />}
          placeholder="6 位验证码"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          autoFocus
        />
      </Form.Item>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Space style={{ width: "100%" }}>
        <Button type="primary" htmlType="submit" size="large" loading={busy}>
          验证
        </Button>
        <Button size="large" onClick={onBack} type="text">
          返回
        </Button>
      </Space>
    </Form>
  );
}

function BrandWall() {
  const feats = [
    { title: "套餐与订阅", desc: "周期 / 流量 / 加量三种模型" },
    { title: "残值换购", desc: "升级只补差价，规则可复核" },
    { title: "自动结算", desc: "每小时按重置点扣减流量" },
    { title: "客户镜像", desc: "与 cf-api 双向一致" },
  ];
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "48px 44px",
        display: "flex",
        flexDirection: "column",
        color: "#fff",
        background: "linear-gradient(160deg, #2a2260 0%, #1b2337 58%, #141a2b 100%)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 520,
          height: 520,
          borderRadius: "50%",
          right: -180,
          bottom: -220,
          background: "radial-gradient(circle, rgba(109,74,255,.45), transparent 62%)",
        }}
      />
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          background: "linear-gradient(135deg, #6d4aff, #b06bff)",
          marginBottom: 22,
          fontWeight: 700,
        }}
      >
        CV
      </div>
      <Typography.Title level={2} style={{ color: "#fff", margin: 0, letterSpacing: -0.5 }}>
        Clever VPN 运营控制台
      </Typography.Title>
      <Typography.Paragraph style={{ color: "#a9b3c7", marginTop: 10, maxWidth: "34ch" }}>
        订阅、套餐、订单、结算一站式管理。数据留在你的账号里，随时可导出。
      </Typography.Paragraph>

      <div
        style={{
          marginTop: "auto",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          position: "relative",
          zIndex: 1,
        }}
      >
        {feats.map((f) => (
          <div
            key={f.title}
            style={{
              background: "rgba(255,255,255,.06)",
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 10,
              padding: "12px 14px",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>{f.title}</div>
            <div style={{ fontSize: 12, color: "#a9b3c7", marginTop: 2 }}>{f.desc}</div>
          </div>
        ))}
      </div>

      <Typography.Text style={{ color: "#6b7690", fontSize: 12, marginTop: 24 }}>
        <ThunderboltFilled style={{ color: "#8b5cff", marginRight: 6 }} />
        Clever VPN · 运营控制台
      </Typography.Text>
    </div>
  );
}
