import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  type AuditEntry,
  type Me,
  type SessionInfo,
} from "../api";

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.message && err.message !== err.code
    ? err.message
    : fallback;

export default function Settings({
  me,
  onMeChanged,
}: {
  me: Me;
  onMeChanged: (me: Me) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <MailCard me={me} />
      <PasswordCard mailReady={me.mail_ready} />
      <TotpCard me={me} onMeChanged={onMeChanged} />
      <SessionsCard />
      <AuditCard />
    </div>
  );
}

function PasswordCard({ mailReady }: { mailReady: boolean }) {
  const [mode, setMode] = useState<"password" | "email">("password");
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [state, setState] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode() {
    setState({ kind: "idle", text: "" });
    try {
      const res = await api.sendPasswordCode();
      setCooldown(res.cooldown ?? 60);
      setState(
        res.code
          ? { kind: "ok", text: `开发环境回显验证码：${res.code}（已自动填入）` }
          : { kind: "ok", text: "验证码已发送到你的邮箱" },
      );
      if (res.code) setCode(res.code);
    } catch (err) {
      setState({ kind: "error", text: message(err, "发送失败") });
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState({ kind: "idle", text: "" });
    try {
      if (mode === "password") await api.changePassword(current, next);
      else await api.changePasswordWithCode(code, next);
      setCurrent("");
      setCode("");
      setNext("");
      setState({ kind: "ok", text: "密码已更新，其它设备已退出登录" });
    } catch (err) {
      setState({ kind: "error", text: message(err, "修改失败") });
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>修改密码</h3>
      <p className="hint">
        修改后其它设备的会话会被吊销。
        {mailReady
          ? "可以用当前密码，也可以改用邮箱验证码（忘了旧密码时用这个）。"
          : "当前未配置邮件，只能用当前密码修改；忘了密码请按 docs/admin.md 用 D1 重置。"}
      </p>

      {mailReady && (
        <div className="actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={mode === "password" ? "primary" : undefined}
            onClick={() => setMode("password")}
          >
            用当前密码
          </button>
          <button
            type="button"
            className={mode === "email" ? "primary" : undefined}
            onClick={() => setMode("email")}
          >
            用邮箱验证码
          </button>
        </div>
      )}

      {mode === "password" ? (
        <div className="field">
          <label htmlFor="current">当前密码</label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="code">邮箱验证码</label>
            <div className="actions">
              <input
                id="code"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <button type="button" onClick={sendCode} disabled={cooldown > 0}>
                {cooldown > 0 ? `${cooldown}s` : "发送验证码"}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="field">
        <label htmlFor="next">新密码（至少 12 位）</label>
        <input
          id="next"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </div>
      {state.kind !== "idle" && (
        <div className={`notice ${state.kind === "ok" ? "ok" : "error"}`}>{state.text}</div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="primary" type="submit">
          保存
        </button>
      </div>
    </form>
  );
}

/** 邮件发信状态 —— 「配了」不等于「能发」，所以给一个真的发一封的按钮 */
function MailCard({ me }: { me: Me }) {
  const [state, setState] = useState<{ kind: "idle" | "ok" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  async function test() {
    setState({ kind: "idle", text: "" });
    try {
      const res = await api.testMail();
      setState({
        kind: "ok",
        text: res.dev ? "开发环境不发信（已打日志）" : "测试邮件已发送，请查收",
      });
    } catch (err) {
      setState({ kind: "error", text: message(err, "发送失败") });
    }
  }

  return (
    <div className="card">
      <h3>邮件发送</h3>
      <p className="hint">
        App 是无密码登录，**发信是硬依赖**：没配好邮件，用户就无法注册/登录；
        管理后台也只剩密码登录。
      </p>
      <div className="actions">
        <span className={`tag ${me.mail_ready ? "tag-active" : "tag-draft"}`}>
          {me.mail_ready ? "已配置" : "未配置"}
        </span>
        <button type="button" onClick={test} disabled={!me.mail_ready}>
          发送测试邮件
        </button>
      </div>
      {state.kind !== "idle" && (
        <div className={`notice ${state.kind === "ok" ? "ok" : "error"}`}>{state.text}</div>
      )}
      {!me.mail_ready && (
        <p className="hint" style={{ marginTop: 8 }}>
          配置方式：`EMAIL` 绑定或 `RESEND_API_KEY`，并且设 `EMAIL_FROM`（域名需验证）。
        </p>
      )}
    </div>
  );
}

function TotpCard({
  me,
  onMeChanged,
}: {
  me: Me;
  onMeChanged: (me: Me) => void;
}) {
  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function enroll() {
    setError("");
    setOk("");
    try {
      setEnrolling(await api.enrollTotp());
    } catch (err) {
      setError(message(err, "无法开始绑定"));
    }
  }

  async function activate(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.activateTotp(code);
      setEnrolling(null);
      setCode("");
      setOk("两步验证已开启");
      onMeChanged(await api.me());
    } catch (err) {
      setError(message(err, "验证码不正确"));
    }
  }

  async function disable(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.disableTotp(password);
      setPassword("");
      setOk("两步验证已关闭");
      onMeChanged(await api.me());
    } catch (err) {
      setError(message(err, "关闭失败，请检查密码"));
    }
  }

  return (
    <div className="card">
      <h3>两步验证（TOTP）</h3>
      <p className="hint">
        用 Google Authenticator / 1Password 等应用扫码或手动输入密钥。
        丢失手机可用 Cloudflare 账号直接改 D1 重置（见 docs/admin.md）。
      </p>

      {error && <div className="notice error">{error}</div>}
      {ok && <div className="notice ok">{ok}</div>}

      {me.totp_enabled ? (
        <form onSubmit={disable} style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="totp-off">输入密码以关闭</label>
            <input
              id="totp-off"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="danger" type="submit">
            关闭两步验证
          </button>
        </form>
      ) : enrolling ? (
        <form onSubmit={activate} style={{ marginTop: 12 }}>
          <div className="field">
            <label>密钥（手动输入到认证器）</label>
            <code>{enrolling.secret}</code>
          </div>
          <div className="field">
            <label>otpauth 链接</label>
            <code>{enrolling.uri}</code>
          </div>
          <div className="field">
            <label htmlFor="totp-code">输入应用里的 6 位验证码</label>
            <input
              id="totp-code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>
          <button className="primary" type="submit">
            启用
          </button>
        </form>
      ) : (
        <div className="actions" style={{ marginTop: 12 }}>
          <button onClick={enroll}>开始绑定</button>
        </div>
      )}
    </div>
  );
}

function SessionsCard() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState("");

  const refresh = () =>
    api
      .sessions()
      .then((res) => setSessions(res.sessions))
      .catch((err) => setError(message(err, "无法加载会话")));

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(sid: string) {
    await api.revokeSession(sid).catch(() => undefined);
    await refresh();
  }

  return (
    <div className="card">
      <h3>登录会话</h3>
      <p className="hint">显示最近使用的浏览器 / IP，可远程踢掉。</p>
      {error && <div className="notice error">{error}</div>}
      {sessions.length === 0 ? (
        <div className="empty">暂无数据</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>会话</th>
                <th>最近活跃</th>
                <th>IP</th>
                <th>客户端</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.sid}>
                  <td>
                    <code>{session.sid}</code>
                    {session.current ? " （当前）" : ""}
                  </td>
                  <td>{new Date(session.last_used_at).toLocaleString()}</td>
                  <td>{session.ip ?? "—"}</td>
                  <td>{session.user_agent ?? "—"}</td>
                  <td>
                    {!session.current && (
                      <button className="danger" onClick={() => revoke(session.sid)}>
                        踢出
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AuditCard() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    api
      .audit(50)
      .then((res) => setEntries(res.entries))
      .catch(() => undefined);
  }, []);

  return (
    <div className="card">
      <h3>审计日志</h3>
      <p className="hint">最近 50 条：登录、改密、2FA、会话吊销。</p>
      {entries.length === 0 ? (
        <div className="empty">暂无数据</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作者</th>
                <th>动作</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{new Date(entry.at).toLocaleString()}</td>
                  <td>{entry.actor}</td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td>
                    {entry.target ? <code>{entry.target}</code> : null} {entry.detail ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
