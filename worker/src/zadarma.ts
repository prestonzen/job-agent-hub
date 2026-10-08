import { HttpError } from "./clickup";
import type { Env } from "./types";

/**
 * EXPERIMENTAL Zadarma API client (call statistics for the burner number).
 *
 * Signing per Zadarma docs: sign = base64( hex( HMAC-SHA1( secret, method + params + md5(params) ) ) )
 * where params is the key-sorted query string encoded like PHP's http_build_query (RFC 1738: spaces as "+"). Header: Authorization: "<key>:<sign>".
 * Credentials come from the ZADARMA_KEY / ZADARMA_SECRET Worker secrets only.
 * Verify against your account before relying on it; endpoints/fields may change.
 */

const BASE = "https://api.zadarma.com";

function md5hex(input: string): string {
  // Web Crypto has no MD5; Zadarma requires it, so use a tiny implementation.
  return md5(input);
}

async function hmacSha1Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PHP http_build_query encoding (what Zadarma signs): RFC 3986 escapes plus "+" for spaces. */
const phpEncode = (v: string) =>
  encodeURIComponent(v)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");

export async function zadarmaGet(env: Env, method: string, params: Record<string, string> = {}): Promise<unknown> {
  if (!env.ZADARMA_KEY || !env.ZADARMA_SECRET) throw new HttpError(503, "ZADARMA_KEY / ZADARMA_SECRET secrets are not set");
  const query = Object.keys(params)
    .sort()
    .map((k) => `${phpEncode(k)}=${phpEncode(params[k])}`)
    .join("&");
  const hex = await hmacSha1Hex(env.ZADARMA_SECRET, method + query + md5hex(query));
  const sign = btoa(hex);
  const res = await fetch(`${BASE}${method}${query ? `?${query}` : ""}`, {
    headers: { Authorization: `${env.ZADARMA_KEY}:${sign}` },
  });
  if (!res.ok) throw new HttpError(502, `Zadarma ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- minimal MD5 (RFC 1321) ---
export function md5(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const n = bytes.length;
  const words: number[] = [];
  for (let i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] ?? 0) | (bytes[i] << ((i % 4) * 8));
  words[n >> 2] = (words[n >> 2] ?? 0) | (0x80 << ((n % 4) * 8));
  const len = (((n + 8) >> 6) + 1) * 16;
  for (let i = 0; i < len; i++) words[i] = words[i] ?? 0;
  words[len - 2] = n * 8;

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const rol = (x: number, c: number) => (x << c) | (x >>> (32 - c));

  for (let off = 0; off < len; off += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + words[off + g]) | 0;
      A = D; D = C; C = B;
      B = (B + rol(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (x: number) => [0, 8, 16, 24].map((s) => ((x >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
