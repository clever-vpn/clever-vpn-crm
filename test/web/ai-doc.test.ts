import { describe, expect, it } from "vitest";

import { AI_DOC_MAX_BYTES, readAiDocument } from "../../web/src/ai-doc";

const BOUNDARY = "----=_NextPart_TEST";

function mhtml(html: string, encoding: "quoted-printable" | "base64" | "none" = "none"): string {
  let body = html;
  if (encoding === "base64") body = Buffer.from(html, "utf8").toString("base64");
  if (encoding === "quoted-printable") {
    body = [...new TextEncoder().encode(html)]
      .map((b) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`)
      .join("");
  }
  const encHeader = encoding === "none" ? "" : `Content-Transfer-Encoding: ${encoding}\r\n`;
  return [
    `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    "Content-Type: text/css",
    "",
    "body { color: red }",
    `--${BOUNDARY}`,
    "Content-Type: text/html; charset=utf-8",
    encHeader,
    body,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

describe("readAiDocument", () => {
  it("txt / md / json 原样返回", () => {
    expect(readAiDocument("doc.txt", "  POST /pay 下单  ")).toEqual({
      text: "POST /pay 下单",
      kind: "text",
    });
    expect(readAiDocument("doc.md", "# API\n下单").kind).toBe("text");
    expect(readAiDocument("doc.json", "{}").kind).toBe("text");
  });

  it("html 去标签、去 script/style，保留正文", () => {
    const html = `<html><head><style>.x{}</style><script>alert(1)</script></head>
      <body><h1>支付接口</h1><p>POST /pay/create</p><p>签名 MD5</p></body></html>`;
    const r = readAiDocument("doc.html", html);
    expect(r.error).toBeUndefined();
    expect(r.kind).toBe("html");
    expect(r.text).toContain("支付接口");
    expect(r.text).toContain("POST /pay/create");
    expect(r.text).not.toContain("alert");
    expect(r.text).not.toContain("<h1>");
  });

  it("mhtml 支持 quoted-printable / base64 / 明文 HTML part", () => {
    const html = "<h1>布拉格</h1><p>POST /api/pay/unifiedorder</p>";
    for (const enc of ["quoted-printable", "base64", "none"] as const) {
      const r = readAiDocument("doc.mhtml", mhtml(html, enc));
      expect(r.error, enc).toBeUndefined();
      expect(r.kind).toBe("mhtml");
      expect(r.text, enc).toContain("布拉格");
      expect(r.text, enc).toContain("/api/pay/unifiedorder");
    }
  });

  it("mhtml 有多个 HTML part 时，选正文最长的（外框通常更长但没正文）", () => {
    const raw = [
      `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
      "",
      `--${BOUNDARY}`,
      "Content-Type: text/html",
      "",
      "<html><body>系统菜单 首页 退出</body></html>",
      `--${BOUNDARY}`,
      "Content-Type: text/html",
      "",
      "<html><body>" + "<h1>支付接口</h1><p>POST /pay/create 签名 MD5</p>".repeat(20) + "</body></html>",
      `--${BOUNDARY}--`,
      "",
    ].join("\r\n");
    const r = readAiDocument("doc.mhtml", raw);
    expect(r.error).toBeUndefined();
    expect(r.text).toContain("支付接口");
    expect(r.text).not.toContain("系统菜单");
  });

  it("mhtml 没有 text/html part → 可解释错误", () => {
    const raw = mhtml("<p>x</p>").replace(/text\/html/g, "text/plain");
    const r = readAiDocument("doc.mhtml", raw);
    expect(r.error).toContain("没有可读的 HTML");
  });

  it("不支持的扩展名 / 空文件 / 超限", () => {
    expect(readAiDocument("api.pdf", "x").error).toContain(".txt / .md / .json / .html");
    expect(readAiDocument("api.txt", "   ").error).toContain("没有可读文本");
    const huge = "x".repeat(AI_DOC_MAX_BYTES + 1);
    expect(readAiDocument("api.txt", huge).error).toContain("超过");
  });
});
