/**
 * Tool definitions for Bitkub public REST endpoints.
 * Each tool returns a single MCP `text` content block with the JSON
 * payload from Bitkub stringified at 2-space indent.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bitkubGet, BitkubApiError } from "./bitkub-client.ts";

// ---- Reusable zod fragments ----------------------------------------------

export const symSchema = z
  .string()
  .regex(/^[a-z]+_[a-z]+$/, "sym must look like 'btc_thb' (lowercase, base_quote)");

const lmtSchema = z
  .number()
  .int("lmt must be an integer")
  .positive("lmt must be a positive integer");

const resolutionSchema = z.enum(["1", "5", "15", "60", "240", "1D"]);

const unixSecSchema = z
  .number()
  .int("must be an integer (unix seconds)")
  .positive("must be a positive unix-seconds timestamp");

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
  if (e instanceof BitkubApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: true,
              status: e.status,
              bitkubErrorCode: e.bitkubErrorCode ?? null,
              message: e.message,
              body: e.body ?? null,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Unexpected error: ${msg}` }],
  };
}

// ---- Tool registration ----------------------------------------------------

export function registerBitkubTools(server: McpServer): void {
  // 1. /api/status
  server.registerTool(
    "bitkub_status",
    {
      title: "Bitkub Status",
      description:
        "GET /api/status — Bitkub system & per-pair status (operational/maintenance).",
      inputSchema: {},
    },
    async () => {
      try {
        return asTextResult(await bitkubGet("/api/status"));
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 2. /api/v3/servertime (milliseconds)
  server.registerTool(
    "bitkub_servertime",
    {
      title: "Bitkub Server Time (milliseconds)",
      description:
        "GET /api/v3/servertime — Bitkub server time as a unix timestamp in milliseconds.",
      inputSchema: {},
    },
    async () => {
      try {
        return asTextResult(await bitkubGet("/api/v3/servertime"));
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 4. /api/v3/market/symbols
  server.registerTool(
    "bitkub_symbols",
    {
      title: "Bitkub Market Symbols",
      description:
        "GET /api/v3/market/symbols — list all available trading pairs and their metadata.",
      inputSchema: {},
    },
    async () => {
      try {
        return asTextResult(await bitkubGet("/api/v3/market/symbols"));
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 5. /api/v3/market/ticker
  server.registerTool(
    "bitkub_ticker",
    {
      title: "Bitkub Market Tickers (single or all)",
      description:
        "GET /api/v3/market/ticker — returns 24h ticker (last/bid/ask/volume/24h-change).\n\n" +
        "PREFERRED USAGE: omit `sym` to fetch ALL ~430 symbols in ONE call — never call this " +
        "tool in a loop. If the user asks about 2+ symbols (e.g. 'compare BTC, ETH, ADA prices'), " +
        "call once with no args and filter the result locally instead of calling 2+ times. " +
        "Only pass `sym` when you genuinely need exactly one symbol.\n\n" +
        "RESPONSE SHAPE — read carefully to avoid lookup mistakes:\n" +
        "  - The response is a JSON ARRAY of objects, NOT a dict keyed by symbol.\n" +
        "  - Each item shape: `{ symbol, last, lowest_ask, highest_bid, base_volume, quote_volume, " +
        "high_24_hr, low_24_hr, percent_change }`. All numeric fields are strings.\n" +
        "  - The `symbol` field is UPPERCASE in BASE_QUOTE order, e.g. `BTC_THB`, `ETH_THB`, " +
        "`ADA_THB`. NOT `THB_BTC`. To look up Bitcoin, filter for `symbol === 'BTC_THB'`.\n" +
        "  - Input `sym` is LOWERCASE `btc_thb`; output `symbol` is UPPERCASE `BTC_THB`. Same " +
        "order, different case. Compare case-insensitively if matching across the boundary.\n" +
        "  - Bitkub trades against THB only (no crypto-crypto pairs), so every `symbol` ends in `_THB`.",
      inputSchema: {
        sym: symSchema
          .optional()
          .describe(
            "OPTIONAL — single trading pair, lowercase, base_quote order like 'btc_thb' " +
              "(NOT 'thb_btc'). Omit this argument entirely to receive all ~430 symbols in " +
              "one response. Do NOT call this tool multiple times with different `sym` " +
              "values; one call without `sym` is faster and avoids rate limits.",
          ),
      },
    },
    async (args) => {
      try {
        const params = args.sym ? { sym: args.sym } : undefined;
        return asTextResult(await bitkubGet("/api/v3/market/ticker", params));
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 6. /api/v3/market/bids
  server.registerTool(
    "bitkub_bids",
    {
      title: "Bitkub Order Book Bids",
      description:
        "GET /api/v3/market/bids — top `lmt` open buy orders for `sym`.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
        lmt: lmtSchema.describe("Number of bid levels to return (positive integer)."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubGet("/api/v3/market/bids", { sym: args.sym, lmt: args.lmt }),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 7. /api/v3/market/asks
  server.registerTool(
    "bitkub_asks",
    {
      title: "Bitkub Order Book Asks",
      description:
        "GET /api/v3/market/asks — top `lmt` open sell orders for `sym`.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
        lmt: lmtSchema.describe("Number of ask levels to return (positive integer)."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubGet("/api/v3/market/asks", { sym: args.sym, lmt: args.lmt }),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 8. /api/v3/market/depth
  server.registerTool(
    "bitkub_depth",
    {
      title: "Bitkub Order Book Depth",
      description:
        "GET /api/v3/market/depth — aggregated bids/asks order book up to `lmt` levels.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
        lmt: lmtSchema.describe("Number of price levels per side."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubGet("/api/v3/market/depth", { sym: args.sym, lmt: args.lmt }),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 9. /api/v3/market/trades
  server.registerTool(
    "bitkub_trades",
    {
      title: "Bitkub Recent Trades",
      description:
        "GET /api/v3/market/trades — most recent `lmt` trades for `sym`.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
        lmt: lmtSchema.describe("Number of recent trades to return."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubGet("/api/v3/market/trades", { sym: args.sym, lmt: args.lmt }),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // 10. /tradingview/history
  server.registerTool(
    "bitkub_tv_history",
    {
      title: "Bitkub TradingView History (OHLCV)",
      description:
        "GET /tradingview/history — historical OHLCV bars for `symbol` between `from` and `to` (unix seconds), at the given `resolution` (1, 5, 15, 60, 240, 1D).",
      inputSchema: {
        symbol: z
          .string()
          .min(1)
          .describe(
            "TradingView symbol — typically the base asset upper-case, e.g. 'BTC' or pair-style 'BTC_THB'. See Bitkub docs.",
          ),
        resolution: resolutionSchema.describe(
          "Bar resolution: 1, 5, 15, 60, 240 (minutes) or '1D' (daily).",
        ),
        from: unixSecSchema.describe("Range start, unix timestamp in seconds."),
        to: unixSecSchema.describe("Range end, unix timestamp in seconds."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubGet("/tradingview/history", {
            symbol: args.symbol,
            resolution: args.resolution,
            from: args.from,
            to: args.to,
          }),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );
}
