import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import Shell from "./pages/Shell";

type Auth =
  | { state: "loading" }
  | { state: "setup"; configured: boolean }
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
          setAuth({ state: "setup", configured: bootstrap.setup_configured });
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
