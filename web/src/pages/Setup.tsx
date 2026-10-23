import { useEffect, useState } from "react";
import { Alert, Button, Col, Form, Input, Row, Typography } from "antd";
import { KeyOutlined, LockOutlined, MailOutlined } from "@ant-design/icons";
import { ApiError, api, type Bootstrap } from "../api";
import Turnstile from "../Turnstile";

/**
 * 首次初始化：创建唯一管理员。
 * 与登录页同一套版式（左品牌墙 / 右表单），手机下只留表单。
 */
export default function Setup({
  configured,
  onDone,
}: {
  configured: boolean;
  onDone: () => void;
}) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 初始化流程没走登录，bootstrap 要单独拉一次才知道要不要渲染 Turnstile
  useEffect(() => {
    api
      .bootstrap()
      .then((boot: Bootstrap) => setSiteKey(boot.turnstile_site_key))
      .catch(() => setSiteKey(null));
  }, []);

  async function submit(values: { token: string; email: string; password: string }) {
    setError("");
    setBusy(true);
    try {
      await api.setup(values.token, values.email, values.password, turnstileToken);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "setup_disabled"
          ? "服务端未配置 SETUP_TOKEN，请先把它写入 Worker secret"
          : err instanceof ApiError && err.code === "invalid_setup_token"
            ? "初始化口令不正确"
            : err instanceof ApiError && err.code === "weak_password"
              ? "密码至少 12 位"
              : err instanceof ApiError && err.code === "turnstile_failed"
                ? "人机校验未通过，请刷新页面后重试"
                : "初始化失败，请稍后再试",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row style={{ minHeight: "100vh", background: "#fff" }}>
      <Col xs={0} md={12} lg={13}>
        <div
          style={{
            minHeight: "100vh",
            padding: "48px 44px",
            display: "flex",
            flexDirection: "column",
            color: "#fff",
            background: "linear-gradient(160deg, #2a2260 0%, #1b2337 58%, #141a2b 100%)",
          }}
        >
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
          <Typography.Title level={2} style={{ color: "#fff", margin: 0 }}>
            首次初始化
          </Typography.Title>
          <Typography.Paragraph style={{ color: "#a9b3c7", marginTop: 10, maxWidth: "34ch" }}>
            控制面的第一次启动。创建唯一运营者账号后，初始化口令立即失效。
          </Typography.Paragraph>
          <div style={{ marginTop: "auto", color: "#a9b3c7", fontSize: 13 }}>
            <p>· 单管理员：没有用户体系，只有你</p>
            <p>· 可恢复：账号丢失用 D1 改回，不留后门接口</p>
          </div>
        </div>
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
              创建管理员
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
              口令来自部署时配置的 <code>SETUP_TOKEN</code>，成功后立即失效。
            </Typography.Paragraph>

            {!configured && (
              <Alert
                type="error"
                showIcon
                message="未检测到 SETUP_TOKEN，初始化会失败。"
                style={{ marginBottom: 16 }}
              />
            )}

            <Form layout="vertical" size="large" requiredMark={false} onFinish={submit}>
              <Form.Item
                name="token"
                label="初始化口令"
                rules={[{ required: true, message: "请输入初始化口令" }]}
              >
                <Input prefix={<KeyOutlined />} placeholder="SETUP_TOKEN" />
              </Form.Item>
              <Form.Item
                name="email"
                label="邮箱"
                rules={[{ required: true, message: "请输入邮箱" }]}
              >
                <Input prefix={<MailOutlined />} placeholder="ops@example.com" autoComplete="username" />
              </Form.Item>
              <Form.Item
                name="password"
                label="密码（至少 12 位）"
                rules={[
                  { required: true, message: "请输入密码" },
                  { min: 12, message: "密码至少 12 位" },
                ]}
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认密码"
                dependencies={["password"]}
                rules={[
                  { required: true, message: "请再次输入密码" },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      return !value || getFieldValue("password") === value
                        ? Promise.resolve()
                        : Promise.reject(new Error("两次输入的密码不一致"));
                    },
                  }),
                ]}
              >
                <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
              </Form.Item>

              {siteKey && <Turnstile siteKey={siteKey} onToken={setTurnstileToken} />}
              {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

              <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                创建并登录
              </Button>
            </Form>
          </div>
        </div>
      </Col>
    </Row>
  );
}
