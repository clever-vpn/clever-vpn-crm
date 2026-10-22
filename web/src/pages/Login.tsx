import { useState } from "react";
import { ApiError, api } from "../api";

export default function Login({ onDone }: { onDone: () => void | Promise<void> }) {
  const [stage, setStage] = useState<"password" | "totp">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.login(email, password);
      if (res.totp_required) setStage("totp");
      else await onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "locked"
          ? "尝试次数过多，请 15 分钟后再试"
          : err instanceof ApiError && err.status === 401
            ? "邮箱或密码不正确"
            : "登录失败，请稍后再试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.loginTotp(code);
      await onDone();
    } catch {
      setError("验证码不正确或已过期");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form
        className="auth-card"
        onSubmit={stage === "password" ? submitPassword : submitTotp}
      >
        <h1>登录</h1>
        <p className="sub">
          {stage === "password" ? "单管理员账号，仅授权运营者使用。" : "输入认证器中的 6 位验证码。"}
        </p>

        {stage === "password" ? (
          <>
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
              <label htmlFor="password">密码</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="code">验证码</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
          </div>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="actions" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "请稍候…" : stage === "password" ? "登录" : "验证"}
          </button>
          {stage === "totp" && (
            <button type="button" onClick={() => setStage("password")}>
              返回
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
