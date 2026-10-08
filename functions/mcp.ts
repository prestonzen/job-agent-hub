// Cloudflare Pages Function: the MCP endpoint (/mcp) that Claude, Codex, Gemini, Kimi, Mistral etc. connect to.
import { handle } from "../worker/src/index";
import type { Env } from "../worker/src/types";

export const onRequest: PagesFunction<Env> = (ctx) => handle(ctx.request, ctx.env, ctx as unknown as ExecutionContext);
