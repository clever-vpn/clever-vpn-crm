import { useState } from "react";
import { ApiError, api } from "../api";

export default function Setup({
  configured,
  onDone,
}: {
  configured: boolean;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      await api.setup(token, email, password);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "setup_disabled"
          ? "服务端未配置 SETUP_TOKEN，请先把它写入 Worker secret"
          : err instanceof ApiError && err.code === "invalid_setup_token"
            ? "初始化口令不正确"
            : err instanceof ApiError && err.code === "weak_password"
              ? "密码至少 12 位"
              : "初始化失败，请稍后再试",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>初始化管理员</h1>
        <p className="sub">
          创建唯一的运营者账号。口令来自部署时配置的 <code>SETUP_TOKEN</code>，
          成功后立即失效。
        </p>

        {!configured && (
          <div className="notice error" style={{ marginBottom: 14 }}>
            未检测到 SETUP_TOKEN，初始化会失败。
          </div>
        )}

        <div className="field">
          <label htmlFor="token">初始化口令</label>
          <input
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">密码（至少 12 位）</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="confirm">确认密码</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {error && <div className="notice error">{error}</div>}

        <div className="actions" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "请稍候…" : "创建并登录"}
          </button>
        </div>
      </form>
    </div>
  );
}
