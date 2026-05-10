/**
 * Read-only SECURE Bitkub tools — v4 where it exists, v3 only where it doesn't.
 *
 * Scope: balances, order/account history, address lists, deposit/withdraw
 * history. NO trading, NO fund movement, NO address generation, NO withdrawals.
 *
 * Auth: v4 uses the same HMAC-SHA256 signing as v3 (X-BTK-APIKEY,
 * X-BTK-TIMESTAMP ms, X-BTK-SIGN). The shared secure-client is path-agnostic.
 *
 * Credentials come from process.env (BITKUB_API_KEY / BITKUB_API_SECRET), set
 * via the MCP client config's `env` block — never from per-call args.
 *
 * Versioning notes for the v3 -> v4 migration:
 *   - v4 endpoints are GET (v3 used POST with body). Same auth scheme; only
 *     the payload-string composition differs (handled by secure-client).
 *   - Param names changed: page (was p), limit (was lmt), symbol (was sym),
 *     created_start / created_end (new). No legacy aliases.
 *   - bitkub_wallet (v3) was dropped — v4 wallet/balances supersedes it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bitkubSecureGet, bitkubSecurePost, BitkubAuthError } from "./secure-client.ts";
import { BitkubApiError } from "./bitkub-client.ts";
import { symSchema } from "./tools.ts";

// ---- Reusable zod fragments ----------------------------------------------

const positiveInt = z.number().int().positive();

// v3 pagination/range fragments (only used by surviving v3 endpoints).
const v3PageSchema = positiveInt.optional().describe("Page number (1-based, optional).");
const v3LmtSchema = positiveInt.optional().describe("Page size limit (optional).");
const v3StartSchema = positiveInt
  .optional()
  .describe("Range start, Unix timestamp in seconds (optional).");
const v3EndSchema = positiveInt
  .optional()
  .describe("Range end, Unix timestamp in seconds (optional).");

const sideSchema = z.enum(["buy", "sell"]).describe("Order side: 'buy' or 'sell'.");

// v4 pagination — separate fragments because validation rules differ per family.
//   - crypto endpoints: limit max 200
//   - fiat endpoints:   page+limit must be paired (both or neither), max 100
const v4PageSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Page number (1-based, optional).");
const v4CryptoLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("Page size, 1–200 (optional).");
const v4FiatPageSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Page number 1–100 (optional). Must be sent together with `limit`.");
const v4FiatLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Page size 1–100 (optional). Must be sent together with `page`.");

const v4SymbolSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Asset symbol filter, e.g. 'btc' or 'usdt' (optional).");
const v4NetworkSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Network filter, e.g. 'BTC', 'ERC20', 'TRC20' (optional).");
const v4MemoSchema = z
  .string()
  .optional()
  .describe("Memo filter — addresses with/without memos (optional).");
const v4StatusSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Status filter (optional). Values defined by Bitkub; passed through unmodified.");
const v4IsoStartSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Range start, ISO 8601 (e.g. '2026-01-01T00:00:00Z') (optional).");
const v4IsoEndSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Range end, ISO 8601 (e.g. '2026-01-31T23:59:59Z') (optional).");

/** Reject "page provided but limit missing" or vice versa. */
const fiatPageLimitPairing = (
  obj: { page?: number; limit?: number },
  ctx: z.RefinementCtx,
) => {
  const hasPage = obj.page !== undefined;
  const hasLimit = obj.limit !== undefined;
  if (hasPage !== hasLimit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "`page` and `limit` must be sent together or both omitted (Bitkub v4 fiat endpoint constraint).",
      path: hasPage ? ["limit"] : ["page"],
    });
  }
};

const v4SegmentSchema = z
  .enum(["funding"])
  .optional()
  .describe(
    "Wallet segment to filter by. Per v4 docs, only 'funding' is currently accepted (optional).",
  );

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
  if (e instanceof BitkubAuthError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: e.message }],
    };
  }
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

/** Build a query object from optional values, dropping undefineds. */
function compactQuery(
  entries: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---- Tool registration ----------------------------------------------------

export function registerBitkubSecureTools(server: McpServer): void {
  // ===================================================================
  // v3 tools KEPT (no v4 equivalent yet)
  // ===================================================================

  // GET /api/v3/market/my-open-orders
  server.registerTool(
    "bitkub_my_open_orders",
    {
      title: "Bitkub My Open Orders (v3)",
      description:
        "Bitkub v3: GET /api/v3/market/my-open-orders — currently open orders for `sym`. (No v4 equivalent yet.) Auth required.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet("/api/v3/market/my-open-orders", { sym: args.sym }),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v3/market/my-order-history
  server.registerTool(
    "bitkub_my_order_history",
    {
      title: "Bitkub My Order History (v3)",
      description:
        "Bitkub v3: GET /api/v3/market/my-order-history — historical filled/cancelled orders for `sym`. Optional pagination and time range. (No v4 equivalent yet.) Auth required.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
        p: v3PageSchema,
        lmt: v3LmtSchema,
        start: v3StartSchema,
        end: v3EndSchema,
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet(
            "/api/v3/market/my-order-history",
            compactQuery({
              sym: args.sym,
              p: args.p,
              lmt: args.lmt,
              start: args.start,
              end: args.end,
            }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v3/market/order-info
  server.registerTool(
    "bitkub_order_info",
    {
      title: "Bitkub Order Info (v3)",
      description:
        "Bitkub v3: GET /api/v3/market/order-info — details for a single order by id and side. Optional `hash`. (No v4 equivalent yet.) Auth required.",
      inputSchema: {
        sym: symSchema.describe("Trading pair, e.g. 'btc_thb'."),
        id: z
          .union([z.string().min(1), z.number().int().positive()])
          .describe("Order id."),
        sd: sideSchema,
        hash: z.string().min(1).optional().describe("Optional order hash."),
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet(
            "/api/v3/market/order-info",
            compactQuery({
              sym: args.sym,
              id: args.id,
              sd: args.sd,
              hash: args.hash,
            }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // POST /api/v3/user/limits
  server.registerTool(
    "bitkub_user_limits",
    {
      title: "Bitkub User Limits (v3)",
      description:
        "Bitkub v3: POST /api/v3/user/limits — user's deposit/withdraw daily/monthly limits and remaining quotas. (No v4 equivalent yet.) Auth required.",
      inputSchema: {},
    },
    async () => {
      try {
        return asTextResult(await bitkubSecurePost("/api/v3/user/limits"));
      } catch (e) {
        return asError(e);
      }
    },
  );

  // POST /api/v3/user/trading-credits
  server.registerTool(
    "bitkub_user_trading_credits",
    {
      title: "Bitkub User Trading Credits (v3)",
      description:
        "Bitkub v3: POST /api/v3/user/trading-credits — current trading credit balance (used to offset trading fees). (No v4 equivalent yet.) Auth required.",
      inputSchema: {},
    },
    async () => {
      try {
        return asTextResult(
          await bitkubSecurePost("/api/v3/user/trading-credits"),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // ===================================================================
  // v4 tools (upgraded from v3)
  // All are GET; query params serialized via the shared client.
  // ===================================================================

  // GET /api/v4/wallet/balances
  server.registerTool(
    "bitkub_balances",
    {
      title: "Bitkub Wallet Balances (v4)",
      description:
        "Bitkub v4: GET /api/v4/wallet/balances — unified wallet/balances (replaces v3 wallet+balances). Optional `segment` filter. Auth required.",
      inputSchema: {
        segment: v4SegmentSchema,
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/wallet/balances",
            compactQuery({ segment: args.segment }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v4/crypto/addresses
  server.registerTool(
    "bitkub_crypto_addresses",
    {
      title: "Bitkub Crypto Addresses (v4)",
      description:
        "Bitkub v4: GET /api/v4/crypto/addresses — list deposit addresses. Read-only (does NOT generate new addresses). Optional filters: `symbol`, `network`, `memo`, `page`, `limit` (max 200). Auth required.",
      inputSchema: {
        page: v4PageSchema,
        limit: v4CryptoLimitSchema,
        symbol: v4SymbolSchema,
        network: v4NetworkSchema,
        memo: v4MemoSchema,
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/crypto/addresses",
            compactQuery({
              page: args.page,
              limit: args.limit,
              symbol: args.symbol,
              network: args.network,
              memo: args.memo,
            }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v4/crypto/deposits  (renamed from bitkub_crypto_deposit_history)
  server.registerTool(
    "bitkub_crypto_deposits",
    {
      title: "Bitkub Crypto Deposits (v4)",
      description:
        "Bitkub v4: GET /api/v4/crypto/deposits — historical crypto deposits. Optional filters: `symbol`, `status`, `created_start`/`created_end` (ISO 8601), `page`, `limit` (max 200). Auth required. (Renamed from v3 bitkub_crypto_deposit_history.)",
      inputSchema: {
        page: v4PageSchema,
        limit: v4CryptoLimitSchema,
        symbol: v4SymbolSchema,
        status: v4StatusSchema,
        created_start: v4IsoStartSchema,
        created_end: v4IsoEndSchema,
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/crypto/deposits",
            compactQuery({
              page: args.page,
              limit: args.limit,
              symbol: args.symbol,
              status: args.status,
              created_start: args.created_start,
              created_end: args.created_end,
            }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v4/crypto/withdraws  (renamed from bitkub_crypto_withdraw_history)
  server.registerTool(
    "bitkub_crypto_withdraws",
    {
      title: "Bitkub Crypto Withdraws (v4)",
      description:
        "Bitkub v4: GET /api/v4/crypto/withdraws — historical crypto withdrawals. READ-ONLY (does NOT initiate withdrawals). Optional filters: `symbol`, `status`, `created_start`/`created_end` (ISO 8601), `page`, `limit` (max 200). Auth required. (Renamed from v3 bitkub_crypto_withdraw_history.)",
      inputSchema: {
        page: v4PageSchema,
        limit: v4CryptoLimitSchema,
        symbol: v4SymbolSchema,
        status: v4StatusSchema,
        created_start: v4IsoStartSchema,
        created_end: v4IsoEndSchema,
      },
    },
    async (args) => {
      try {
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/crypto/withdraws",
            compactQuery({
              page: args.page,
              limit: args.limit,
              symbol: args.symbol,
              status: args.status,
              created_start: args.created_start,
              created_end: args.created_end,
            }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v4/fiat/accounts
  // Schema enforces: page+limit must be both present or both absent.
  const fiatAccountsRaw = z.object({
    page: v4FiatPageSchema,
    limit: v4FiatLimitSchema,
  });
  const fiatAccountsSchema = fiatAccountsRaw.superRefine(fiatPageLimitPairing);
  server.registerTool(
    "bitkub_fiat_accounts",
    {
      title: "Bitkub Fiat Accounts (v4)",
      description:
        "Bitkub v4: GET /api/v4/fiat/accounts — linked fiat (THB) bank accounts. `page` and `limit` (1–100) must be sent together or both omitted. Auth required.",
      inputSchema: fiatAccountsRaw.shape,
    },
    async (args) => {
      try {
        const parsed = fiatAccountsSchema.parse(args);
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/fiat/accounts",
            compactQuery({ page: parsed.page, limit: parsed.limit }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v4/fiat/deposit/history  (renamed from bitkub_fiat_deposit_history)
  const fiatDepositsRaw = z.object({
    page: v4FiatPageSchema,
    limit: v4FiatLimitSchema,
  });
  const fiatDepositsSchema = fiatDepositsRaw.superRefine(fiatPageLimitPairing);
  server.registerTool(
    "bitkub_fiat_deposits",
    {
      title: "Bitkub Fiat Deposits (v4)",
      description:
        "Bitkub v4: GET /api/v4/fiat/deposit/history — historical fiat (THB) deposits. `page` and `limit` (1–100) must be sent together or both omitted. Auth required. (Renamed from v3 bitkub_fiat_deposit_history.)",
      inputSchema: fiatDepositsRaw.shape,
    },
    async (args) => {
      try {
        const parsed = fiatDepositsSchema.parse(args);
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/fiat/deposit/history",
            compactQuery({ page: parsed.page, limit: parsed.limit }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );

  // GET /api/v4/fiat/withdraw/history  (renamed from bitkub_fiat_withdraw_history)
  const fiatWithdrawsRaw = z.object({
    page: v4FiatPageSchema,
    limit: v4FiatLimitSchema,
  });
  const fiatWithdrawsSchema = fiatWithdrawsRaw.superRefine(fiatPageLimitPairing);
  server.registerTool(
    "bitkub_fiat_withdraws",
    {
      title: "Bitkub Fiat Withdraws (v4)",
      description:
        "Bitkub v4: GET /api/v4/fiat/withdraw/history — historical fiat (THB) withdrawals. READ-ONLY (does NOT initiate withdrawals). `page` and `limit` (1–100) must be sent together or both omitted. Auth required. (Renamed from v3 bitkub_fiat_withdraw_history.)",
      inputSchema: fiatWithdrawsRaw.shape,
    },
    async (args) => {
      try {
        const parsed = fiatWithdrawsSchema.parse(args);
        return asTextResult(
          await bitkubSecureGet(
            "/api/v4/fiat/withdraw/history",
            compactQuery({ page: parsed.page, limit: parsed.limit }),
          ),
        );
      } catch (e) {
        return asError(e);
      }
    },
  );
}
