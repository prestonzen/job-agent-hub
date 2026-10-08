import type { Env } from "./types";

/**
 * Admin auth = Cloudflare Access. Access sits in front of /admin* and /api/admin/*, and
 * attaches a signed JWT (Cf-Access-Jwt-Assertion). We still verify it here so the API is
 * safe even if the Access policy is misconfigured.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let jwksCache: { at: number; keys: Jwk[] } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const dec = new TextDecoder();

async function getKeys(env: Env): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("could not fetch Access certs");
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys };
  return keys;
}

function isLocal(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

/** Returns the admin's email if the request is authorized, otherwise null. */
export async function adminEmail(request: Request, env: Env): Promise<string | null> {
  // Local development only: MOCK mode on localhost skips Access.
  if (env.MOCK === "true" && isLocal(request)) return "local-dev@example.com";

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAILS) return null;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(b64urlToBytes(parts[0]))) as { kid: string };
    const payload = JSON.parse(dec.decode(b64urlToBytes(parts[1]))) as {
      aud: string | string[];
      exp: number;
      iss: string;
      email?: string;
    };
    if (payload.exp * 1000 < Date.now()) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(env.ACCESS_AUD)) return null;

    const jwk = (await getKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok || !payload.email) return null;

    const allowed = (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase());
    return allowed.includes(payload.email.toLowerCase()) ? payload.email : null;
  } catch {
    return null;
  }
}

function tokenMap(env: Env): Record<string, string> {
  if (!env.AGENT_TOKENS) return {};
  try {
    return JSON.parse(env.AGENT_TOKENS) as Record<string, string>;
  } catch {
    return {}; // malformed secret
  }
}

/** Configured agent names (never the tokens). */
export function agentNames(env: Env): string[] {
  return Object.keys(tokenMap(env)).map((n) => n.toLowerCase());
}

/** Agent API auth: Authorization: Bearer <token>, matched against the AGENT_TOKENS secret. */
export function agentName(request: Request, env: Env): string | null {
  const h = request.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  let found: string | null = null;
  // Compare against every token (no early exit) so timing doesn't reveal which name matched.
  for (const [name, tok] of Object.entries(tokenMap(env))) {
    if (tok.length >= 24 && timingSafeEqual(tok, m[1].trim())) found = name.toLowerCase();
  }
  return found;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
