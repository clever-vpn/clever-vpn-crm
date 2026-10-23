import { useEffect, useRef } from "react";

/**
 * Turnstile 挂件（仅在服务端下发了 site key 时渲染）
 *
 * 用 `render=explicit` + `turnstile.render()`，而不是 `class="cf-turnstile"`：
 * React 里 DOM 会被重建，隐式扫描只在页面加载时跑一次，重挂即失效。
 */

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "flexible" | "compact";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ): string;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export default function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  /** token 失效/报错时会收到空串 —— 调用方应据此禁用提交 */
  onToken: (token: string) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;

  useEffect(() => {
    let disposed = false;

    const mount = () => {
      if (disposed || !holder.current || !window.turnstile) return;
      holder.current.innerHTML = "";
      window.turnstile.render(holder.current, {
        sitekey: siteKey,
        theme: "light",
        callback: (token) => callback.current(token),
        "expired-callback": () => callback.current(""),
        "error-callback": () => callback.current(""),
      });
    };

    if (window.turnstile) {
      mount();
      return () => {
        disposed = true;
      };
    }

    const existing = document.querySelector<HTMLScriptElement>("script[data-crm-turnstile]");
    if (existing) {
      existing.addEventListener("load", mount);
      return () => {
        disposed = true;
        existing.removeEventListener("load", mount);
      };
    }

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.crmTurnstile = "1";
    script.addEventListener("load", mount);
    document.head.appendChild(script);
    return () => {
      disposed = true;
      script.removeEventListener("load", mount);
    };
  }, [siteKey]);

  return <div ref={holder} style={{ marginBottom: 12 }} />;
}
