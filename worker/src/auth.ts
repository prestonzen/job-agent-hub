import type { Env } from "./types";

/**
 * Admin auth = one long random ADMIN_TOKEN (a Pages secret). The admin page trades it once for a
 * signed, HttpOnly session cookie; scripts can send it as a bearer token instead. Rotating the
 * secret logs every session out.
 */

const COOKIE = "jah_admin";
const SESSION_SECONDS = 30 * 86_400;
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(env: Env, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function isLocal(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

const adminConfigured = (env: Env) => !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24;

/** True if `token` is the admin token. */
export function isAdminToken(env: Env, token: string): boolean {
  return adminConfigured(env) && timingSafeEqual(env.ADMIN_TOKEN!, token.trim());
}

/** Returns "admin" if the request carries a valid session cookie or admin bearer token, otherwise null. */
export async function adminUser(request: Request, env: Env): Promise<string | null> {
  // Local development only: MOCK mode on localhost skips login.
  if (env.MOCK === "true" && isLocal(request)) return "local-dev";
  if (!adminConfigured(env)) return null;

  const bearer = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (bearer && isAdminToken(env, bearer[1])) return "admin";

  const cookie = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!cookie) return null;
  const [exp, sig] = cookie[1].split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return null;
  return timingSafeEqual(await sign(env, `admin.${exp}`), sig) ? "admin" : null;
}

/** Set-Cookie value for a fresh admin session. */
export async function sessionCookie(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${COOKIE}=${exp}.${await sign(env, `admin.${exp}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

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
