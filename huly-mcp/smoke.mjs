// Smoke test: start the server over stdio as an MCP client, list tools, read the schema and one issue.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const text = (r) => r.content?.[0]?.text ?? "";
console.log("schema:", text(await client.callTool({ name: "huly_project_schema", arguments: {} })).slice(0, 600));
console.log("issues:", text(await client.callTool({ name: "huly_list_issues", arguments: { status: "screening", limit: 3 } })).slice(0, 800));
const one = JSON.parse(text(await client.callTool({ name: "huly_list_issues", arguments: { search: "Astoria", limit: 1 } })))[0];
console.log("get:", text(await client.callTool({ name: "huly_get_issue", arguments: { identifier: one.identifier } })).slice(0, 700));
console.log("docs:", text(await client.callTool({ name: "huly_list_documents", arguments: {} })).slice(0, 500));
await client.close();
