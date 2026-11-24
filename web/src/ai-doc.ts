/**
 * AI 配置助手的文档导入：把用户选的文件转成**纯文本**。
 *
 * 只做本地转换（不联网、不上传文件本身）；转换后的正文再随生成请求发给服务端。
 * 支持：
 *   - `.txt` / `.md` / `.json`：原样；
 *   - `.html` / `.htm`：去 script/style 后取正文；
 *   - `.mhtml` / `.mht`：从 MIME 里取出 text/html 部分（支持 base64 / quoted-printable）；
 * 其它类型（PDF/Word/图片）不做解析，提示用户另存为文本或直接粘贴。
 */

export const AI_DOC_MAX_BYTES = 60 * 1024;

export interface AiDocFile {
  text: string;
  error?: string;
  /** 实际读取到的格式（排障/提示用） */
  kind: "text" | "html" | "mhtml";
}

const TEXT_EXT = new Set(["txt", "md", "markdown", "json"]);
const HTML_EXT = new Set(["html", "htm"]);
const MHTML_EXT = new Set(["mhtml", "mht"]);
const MAX_BYTES = AI_DOC_MAX_BYTES;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 块级标签换行，避免整份文档挤成一行；DOMParser 的 textContent 不保留布局。 */
function withLineBreaks(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|pre)>/gi, "\n");
}

function decodeBase64(body: string): string {
  const bin = atob(body.replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === "=") {
      if (s[i + 1] === "\r" && s[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (s[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从 MHTML 里取**正文最长**的 text/html part。
 *
 * 离线保存页常有两个 HTML：外框（侧栏/标题，几乎没正文）和真正的文档页。
 * 按 HTML 大小选会选错（外框往往更大），所以按去标签后的文本长度选。
 */
function htmlFromMhtml(raw: string): string | null {
  const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(raw)?.[1];
  if (!boundary) return null;
  const parts = raw.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`));
  let best: string | null = null;
  let bestLen = -1;
  for (const part of parts) {
    const sep = /\r?\n\r?\n/.exec(part);
    if (!sep) continue;
    const headers = part.slice(0, sep.index);
    if (!/content-type:\s*text\/html/i.test(headers)) continue;
    const body = part.slice(sep.index + sep[0].length);
    const enc = /content-transfer-encoding:\s*(\S+)/i.exec(headers)?.[1]?.toLowerCase();
    let html: string;
    if (enc === "base64") {
      try {
        html = decodeBase64(body);
      } catch {
        continue;
      }
    } else if (enc === "quoted-printable") {
      html = decodeQuotedPrintable(body);
    } else {
      html = body;
    }
    const len = htmlToText(html).length;
    if (len > bestLen) {
      best = html;
      bestLen = len;
    }
  }
  return best;
}

/** 只声明用到的 DOM 形状：根 tsconfig 没有 DOM lib（worker 侧也不该有）。 */
interface ParsedDocument {
  body: { textContent: string } | null;
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
}
type DocumentParser = new () => {
  parseFromString(input: string, type: "text/html"): ParsedDocument;
};

function htmlToText(html: string): string {
  const marked = withLineBreaks(html);
  const Parser = (globalThis as { DOMParser?: DocumentParser }).DOMParser;
  if (!Parser) {
    return marked
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }
  const doc = new Parser().parseFromString(marked, "text/html");
  Array.from(doc.querySelectorAll("script,style,noscript,template")).forEach((el) => el.remove());
  const text = doc.body?.textContent ?? "";
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 读一个文件（名字 + 文本）→ 可用于 AI 生成的正文；不支持的格式返回 error。 */
export function readAiDocument(fileName: string, raw: string): AiDocFile {
  const ext = extOf(fileName);
  let text: string;
  let kind: AiDocFile["kind"];

  if (TEXT_EXT.has(ext)) {
    text = raw;
    kind = "text";
  } else if (HTML_EXT.has(ext)) {
    text = htmlToText(raw);
    kind = "html";
  } else if (MHTML_EXT.has(ext)) {
    const html = htmlFromMhtml(raw);
    if (!html) {
      return {
        text: "",
        kind: "mhtml",
        error: "这个 MHTML 里没有可读的 HTML 正文（可能被压缩/加密）；请另存为 HTML，或直接粘贴正文",
      };
    }
    text = htmlToText(html);
    kind = "mhtml";
  } else {
    return {
      text: "",
      kind: "text",
      error: "只支持 .txt / .md / .json / .html / .mhtml；PDF、Word、图片请另存为文本或直接粘贴",
    };
  }

  text = text.trim();
  if (!text) return { text: "", kind, error: "文件里没有可读文本" };
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    return {
      text: "",
      kind,
      error: `文档正文超过 ${MAX_BYTES / 1024} KB，请删减后再导入`,
    };
  }
  return { text, kind };
}
