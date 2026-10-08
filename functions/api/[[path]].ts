// Cloudflare Pages Function: every /api/* request runs the shared handler in worker/src.
import { handle } from "../../worker/src/index";
import type { Env } from "../../worker/src/types";

export const onRequest: PagesFunction<Env> = (ctx) => handle(ctx.request, ctx.env, ctx as unknown as ExecutionContext);
