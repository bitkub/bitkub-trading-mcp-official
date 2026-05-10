/**
 * MCP tools for Bitkub WebSocket "snapshot" collection.
 *
 * Three tools:
 *   - bitkub_ws_ticker_snapshot  (public ticker)
 *   - bitkub_ws_order_updates    (private order_update channel)
 *   - bitkub_ws_match_updates    (private match_update channel)
 *
 * All three follow the snapshot pattern: open WS, collect for a bounded
 * duration, close, return events. Stateless. Read-only.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  wsCollectPublicTicker,
  wsCollectPrivate,
  BitkubWsError,
  BitkubWsAuthError,
  type WsCollectResult,
} from "./ws-client.ts";
import { symSchema } from "./tools.ts";

// ---- Helpers --------------------------------------------------------------

function asTextResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function asError(e: unknown) {
  if (e instanceof BitkubWsAuthError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: e.message }],
    };
  }
  if (e instanceof BitkubWsError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: e.message }],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Unexpected error: ${msg}` }],
  };
}

/**
 * Bitkub private events carry `data.symbol` in `BASE_QUOTE` uppercase
 * (e.g. `BTC_THB`). The tool's optional `sym` filter is the lowercase
 * `base_quote` form. Match either casing for safety.
 */
function eventMatchesSym(ev: Record<string, unknown>, symLower: string): boolean {
  const data = ev.data;
  if (!data || typeof data !== "object") return false;
  const sRaw = (data as Record<string, unknown>).symbol;
  if (typeof sRaw !== "string") return false;
  return sRaw.toLowerCase() === symLower;
}

function postFilterBySym(result: WsCollectResult, symLower?: string): WsCollectResult {
  if (!symLower) return result;
  const filtered = result.events.filter((ev) => eventMatchesSym(ev, symLower));
  return { ...result, events: filtered, count: filtered.length };
}

// ---- Schemas --------------------------------------------------------------

const tickerDuration = z
  .number()
  .int()
  .min(1000)
  .max(60_000)
  .optional()
  .describe(
    "Snapshot window in milliseconds (1000–60000). Default 10000 (10 seconds).",
  );

const privateDuration = z
  .number()
  .int()
  .min(1000)
  .max(120_000)
  .optional()
  .describe(
    "Snapshot window in milliseconds (1000–120000). Default 30000 (30 seconds).",
  );

const optionalSymForFilter = symSchema
  .optional()
  .describe(
    "Optional post-filter: only return events whose data.symbol matches this pair (e.g. 'btc_thb'). Omit to receive all events for the account.",
  );

// ---- Registration ---------------------------------------------------------

export function registerBitkubWsTools(server: McpServer): void {
  // 1. PUBLIC ticker snapshot
  server.registerTool(
    "bitkub_ws_ticker_snapshot",
    {
      title: "Bitkub WS Ticker Snapshot (public)",
      description:
        "Open a WebSocket to Bitkub's public ticker stream for a single symbol, collect ticker updates for the requested duration, then close. Returns the full sequence of events. Use when you need to OBSERVE price/bid/ask movement over a short window (e.g. 'sample BTC/THB price for 10 seconds'). For a single point-in-time price, use `bitkub_ticker` (REST) instead.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb' (lowercase base_quote)."),
        duration_ms: tickerDuration,
      },
    },
    async (args) => {
      try {
        const duration = args.duration_ms ?? 10_000;
        const result = await wsCollectPublicTicker(args.sym, duration);
        return asTextResult(result);
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 2. PRIVATE order_update snapshot
  server.registerTool(
    "bitkub_ws_order_updates",
    {
      title: "Bitkub WS Order Updates (private)",
      description:
        "Subscribe to your account's private order_update stream and collect events for the requested duration, then close. Captures order lifecycle transitions (new, open, partial_filled, filled, canceled). IMPORTANT: only events occurring AFTER subscription begins are captured — to observe an order's full lifecycle, call this in PARALLEL with the order placement, or follow up with `bitkub_order_info` for the authoritative final state. Requires API key in env.",
      inputSchema: {
        duration_ms: privateDuration,
        sym: optionalSymForFilter,
      },
    },
    async (args) => {
      try {
        const duration = args.duration_ms ?? 30_000;
        const result = await wsCollectPrivate("order_update", duration);
        return asTextResult(postFilterBySym(result, args.sym));
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 3. PRIVATE match_update snapshot
  server.registerTool(
    "bitkub_ws_match_updates",
    {
      title: "Bitkub WS Match Updates (private)",
      description:
        "Subscribe to your account's private match_update stream and collect trade-execution (fill) events for the requested duration. Each event is one match — an order can have multiple. Includes price, fee_rate, is_maker, txn_id. Use this to compute weighted-average fill prices and total fees. Requires API key in env. Same race-condition caveat as order_updates.",
      inputSchema: {
        duration_ms: privateDuration,
        sym: optionalSymForFilter,
      },
    },
    async (args) => {
      try {
        const duration = args.duration_ms ?? 30_000;
        const result = await wsCollectPrivate("match_update", duration);
        return asTextResult(postFilterBySym(result, args.sym));
      } catch (e) {
        return asError(e);
      }
    },
  );
}
