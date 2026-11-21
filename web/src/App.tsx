import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import NotInitialized from "./pages/NotInitialized";
import Shell from "./pages/Shell";

type Auth =
  | { state: "loading" }
  | { state: "setup"; configured: boolean; multi: boolean }
  | { state: "login" }
  | { state: "in"; me: Me };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ state: "loading" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bootstrap = await api.bootstrap();
        if (!alive) return;
        if (bootstrap.needs_setup) {
          setAuth({
            state: "setup",
            configured: bootstrap.setup_configured,
            multi: Boolean(bootstrap.multi),
          });
          return;
        }
        const me = await api.me();
        if (alive) setAuth({ state: "in", me });
      } catch {
        if (alive) setAuth({ state: "login" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (auth.state === "loading") {
    return <div className="empty">加载中…</div>;
  }

  if (auth.state === "setup") {
    // SaaS 分片：没有"首次初始化"这回事（管理员由平台在开通时种），
    // 给租户看一句能行动的话，而不是 SETUP_TOKEN 那种部署期概念。
    if (auth.multi) {
      return <NotInitialized onRetry={() => window.location.reload()} />;
    }
    return (
      <Setup
        configured={auth.configured}
        onDone={() => setAuth({ state: "login" })}
      />
    );
  }

  if (auth.state === "login") {
    return (
      <Login
        onDone={async () => setAuth({ state: "in", me: await api.me() })}
      />
    );
  }

  return (
    <Shell
      me={auth.me}
      onLoggedOut={() => setAuth({ state: "login" })}
      onMeChanged={(me) => setAuth({ state: "in", me })}
    />
  );
}
