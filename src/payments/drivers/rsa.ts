/**
 * RSA-SHA256（PKCS#1 v1.5）签名/验签。
 *
 * 易支付 V2 用「商户私钥签请求 + 平台公钥验响应/回调」；WebCrypto 的
 * `RSASSA-PKCS1-v1_5` 正好是 SHA256withRSA。
 *
 * PEM 只接受 PKCS#8 私钥（BEGIN PRIVATE KEY）与 SPKI 公钥（BEGIN PUBLIC KEY）；
 * PKCS#1 的 `BEGIN RSA PRIVATE KEY` 需要先转换，否则明确报错，不猜。
 */

const enc = new TextEncoder();

function pemBody(pem: string, label: string): Uint8Array | null {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const start = pem.indexOf(begin);
  const stop = pem.indexOf(end);
  if (start < 0 || stop < 0 || stop <= start) return null;
  const body = pem
    .slice(start + begin.length, stop)
    .replace(/\s+/g, "");
  if (!body) return null;
  try {
    const raw = atob(body);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey | null> {
  const bytes = pemBody(pem, "PRIVATE KEY");
  if (!bytes) return null;
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return null;
  }
}

export async function importRsaPublicKey(pem: string): Promise<CryptoKey | null> {
  const bytes = pemBody(pem, "PUBLIC KEY");
  if (!bytes) return null;
  try {
    return await crypto.subtle.importKey(
      "spki",
      bytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text.replace(/\s+/g, ""));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function rsaSignBase64(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, enc.encode(message));
  return toBase64(new Uint8Array(sig));
}

export async function rsaVerifyBase64(
  publicKey: CryptoKey,
  message: string,
  signature: string,
): Promise<boolean> {
  const sig = fromBase64(signature);
  if (!sig) return false;
  try {
    return await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      sig,
      enc.encode(message),
    );
  } catch {
    return false;
  }
}
