#!/usr/bin/env node
// Mint a personal Huly workspace token.
//
// Huly has no "API key" page. @hcengineering/api-client authenticates with either
// { email, password, workspace } or { token, workspace } — so the workspace token IS
// the API key, and it carries whatever permissions the account has. A member whose
// only project membership is GALAX gets a token that can only touch GALAX.
//
// Run it from the huly-mcp directory, which already has the dependency installed:
//
//   cd huly-mcp
//   HULY_EMAIL=you@example.com HULY_PASSWORD='...' node ../get-my-huly-token.mjs > ~/.huly-token.txt
//
// Then point your own MCP config at that file as HULY_TOKEN_FILE, or paste the value
// into HULY_TOKEN. Do not commit it, and do not paste it into a chat or a task.
//
// Pass the password through the environment, not as an argument — arguments land in
// shell history and in `ps`.

import api from "@hcengineering/api-client"; // CJS build: default import, then destructure (same as server.mjs)

const { getWorkspaceToken } = api;

const URL = process.env.HULY_URL ?? "https://projects.kaizenapps.com";
const WORKSPACE = process.env.HULY_WORKSPACE ?? "kaizengroup";
const email = process.env.HULY_EMAIL;
const password = process.env.HULY_PASSWORD;

if (!email || !password) {
  console.error("set HULY_EMAIL and HULY_PASSWORD in the environment");
  process.exit(2);
}

// getWorkspaceToken reads <URL>/config.json to find the accounts service, logs in,
// then calls selectWorkspace — the same path the MCP server takes with a token.
const { token, workspaceId, endpoint } = await getWorkspaceToken(URL, { email, password, workspace: WORKSPACE });

if (!token) throw new Error("no token returned — check the email, password, and that this account is a member of the workspace");

// Token to stdout so it can be redirected to a file; everything else to stderr.
console.log(token);
console.error(`\nok: ${email} on ${WORKSPACE} (${workspaceId})`);
console.error(`endpoint: ${endpoint}`);
console.error("This token inherits your permissions — it can only reach projects you are a member of.");
