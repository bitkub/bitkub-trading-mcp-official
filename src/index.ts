#!/usr/bin/env bun
/**
 * bitkub-trading-mcp — MCP stdio server exposing Bitkub REST + WebSocket.
 *   - Public market-data tools (no auth, v3)
 *   - Read-only secure tools — Bitkub v4 where available, v3 fallback
 *     (HMAC-SHA256 auth via env; same signing scheme for v3 and v4)
 *   - WebSocket "snapshot" tools — public ticker + private order/match streams
 *     (each call opens, collects for a bounded window, closes; stateless)
 *
 * Credentials (secure REST + private WS) are read from process.env:
 *   BITKUB_API_KEY, BITKUB_API_SECRET
 * supplied via the MCP client config's `env` block. They are never accepted
 * as per-call args, so the LLM cannot see them.
 *
 * IMPORTANT: stdout is reserved for the MCP transport. Never write to
 * stdout — use stderr only for diagnostics.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBitkubTools } from "./tools.ts";
import { registerBitkubSecureTools } from "./secure-tools.ts";
import { registerBitkubWsTools } from "./ws-tools.ts";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "bitkub-trading-mcp",
    version: "1.0.2",
  });

  registerBitkubTools(server);
  registerBitkubSecureTools(server);
  registerBitkubWsTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Diagnostics on stderr only.
  const hasCreds = Boolean(
    process.env.BITKUB_API_KEY?.trim() && process.env.BITKUB_API_SECRET?.trim(),
  );
  const credNote = hasCreds
    ? "creds present"
    : "creds missing — secure REST + private WS tools will return an auth error until BITKUB_API_KEY/SECRET are set";
  process.stderr.write(
    `[bitkub-trading-mcp] connected on stdio; public + secure + ws tools registered (${credNote}).\n`,
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[bitkub-trading-mcp] fatal: ${msg}\n`);
  process.exit(1);
});
