import { useEffect, useState } from "react";
import { ApiError, api, type Bootstrap } from "../api";

/**
 * 登录：密码 / 邮箱验证码两条路径。
 * 邮箱那条**只在服务端真的能发信时才显示**（bootstrap.methods）——
 * 自托管没配邮件时这里就只有密码，而不是给个点了报错的按钮。
 */
export default function Login({ onDone }: { onDone: () => void | Promise<void> }) {
  const [stage, setStage] = useState<"password" | "totp">("password");
  const [mode, setMode] = useState<"password" | "email">("password");
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [devCode, setDevCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
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

  async function sendEmailCode() {
    setBusy(true);
    setError("");
    setDevCode("");
    try {
      const res = await api.loginEmailStart(email);
      setCooldown(res.cooldown ?? 60);
      if (res.code) setDevCode(res.code);
      setStage("password"); // 不切 stage，下面用 mode 控制表单
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "email_unavailable"
          ? "服务端未配置邮件发送，请使用密码登录"
          : "验证码发送失败，请稍后再试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitEmailCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.loginEmailVerify(email, code);
      if (res.totp_required) setStage("totp");
      else await onDone();
    } catch {
      setError("验证码不正确或已过期");
    } finally {
      setBusy(false);
    }
  }

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
        onSubmit={
          stage === "totp" ? submitTotp : mode === "email" ? submitEmailCode : submitPassword
        }
      >
        <h1>登录</h1>
        <p className="sub">
          {stage === "totp"
            ? "输入认证器中的 6 位验证码。"
            : mode === "email"
              ? "给管理员邮箱发一封 6 位验证码。"
              : "单管理员账号，仅授权运营者使用。"}
        </p>

        {stage !== "totp" && emailModeAvailable && (
          <div className="actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={mode === "password" ? "primary" : undefined}
              onClick={() => { setMode("password"); setError(""); }}
            >
              密码
            </button>
            <button
              type="button"
              className={mode === "email" ? "primary" : undefined}
              onClick={() => { setMode("email"); setError(""); }}
            >
              邮箱验证码
            </button>
          </div>
        )}

        {stage === "totp" ? (
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
        ) : (
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
            {mode === "password" ? (
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
            ) : (
              <>
                <div className="actions" style={{ marginBottom: 8 }}>
                  <button type="button" onClick={sendEmailCode} disabled={busy || cooldown > 0}>
                    {cooldown > 0 ? `${cooldown}s 后可重发` : "发送验证码"}
                  </button>
                </div>
                {devCode && (
                  <div className="notice ok" style={{ marginBottom: 8 }}>
                    开发环境回显验证码：<b>{devCode}</b>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="code">验证码</label>
                  <input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </div>
              </>
            )}
          </>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="actions" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "请稍候…" : stage === "totp" ? "验证" : mode === "email" ? "用验证码登录" : "登录"}
          </button>
          {stage === "totp" && (
            <button type="button" onClick={() => { setStage("password"); setCode(""); }}>
              返回
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
