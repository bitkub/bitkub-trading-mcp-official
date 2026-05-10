<div align="center">

# Bitkub MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20.6+](https://img.shields.io/badge/node-20.0+-blue.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io)

An [MCP](https://modelcontextprotocol.io) server that exposes Bitkub's REST and WebSocket endpoints as tools. Built with Bun + TypeScript and the official `@modelcontextprotocol/sdk`, served over stdio.

> ⚠️ **READ-ONLY BY DESIGN.** This server **never** places orders, cancels orders, generates addresses, or initiates withdrawals. Only data-retrieval and observation endpoints are exposed. Even if you give it a key with full trading permissions, it cannot move money or submit orders — those endpoints are not implemented in the code.
</div>

## Install

**Requirement:** Node.js ≥ 20 (`node --version` to check). No clone, no build — the MCP client downloads the package on first launch via `npx`.

### Quick install — Claude Code CLI (recommended)

One command, no JSON editing.

#### Public data only (no API key needed)

If you just want market data — prices, order books, candles, public ticker stream — skip the env block entirely:

```bash
claude mcp add bitkub-trading-mcp -- npx -y bitkub-trading-mcp
```

The 9 public REST tools and the 1 public WebSocket ticker tool work immediately. The 12 secure REST tools and 2 private WebSocket tools register but each call returns an auth error explaining how to add keys.

#### With API key (full features — your wallet or order and match transaction)

Replace the two placeholder values with your real Bitkub key + secret. See [Add your API key](#add-your-api-key) for how to generate them.

```bash
claude mcp add bitkub-trading-mcp \
  -e BITKUB_API_KEY=your_real_key_here \
  -e BITKUB_API_SECRET=your_real_secret_here \
  -- npx -y bitkub-trading-mcp
```

#### Make it available across all projects

Add `-s user` to either command above:

```bash
claude mcp add bitkub-trading-mcp -s user -- npx -y bitkub-trading-mcp
```

After running any of these, `/exit` and `claude` again. Verify with `/mcp`.

### Manual install (Claude Desktop or hand-editing config)

If you're using Claude Desktop, or prefer to edit the config file by hand, follow the three steps below.

### 1. Open your MCP client config file

| Client | Config file path |
|---|---|
| **Claude Code** (all platforms) | `~/.claude.json` (Linux/macOS/WSL) or `%USERPROFILE%\.claude.json` (Windows) |
| **Claude Desktop** — macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop** — Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Desktop** — Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist yet, create it with `{ "mcpServers": {} }` as the contents.

### 2. Add the `bitkub-trading-mcp` block

Inside the `mcpServers` object, add this entry. If you already have other MCP servers configured, separate them with a comma — it's a normal JSON object.

```json
{
  "mcpServers": {
    "bitkub-trading-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "bitkub-trading-mcp"],
      "env": {
        "BITKUB_API_KEY": "your_api_key_here",
        "BITKUB_API_SECRET": "your_api_secret_here"
      }
    }
  }
}
```

Replace the two `your_..._here` placeholders with your real Bitkub key + secret — see [Add your API key](#add-your-api-key) below for how to generate them.

### 3. Restart the client and verify

- **Claude Code:** `/exit` then `claude` again. Then run `/mcp`.
- **Claude Desktop:** quit the app fully (right-click tray icon → Quit on Windows; Cmd+Q on macOS) and relaunch.

You should see `bitkub-trading-mcp` connected with 24 tools. The first launch downloads the package from npm (~5–10 seconds); subsequent launches use the cached version.

If `BITKUB_API_KEY`/`BITKUB_API_SECRET` are absent, the public tools still work; secure tools register but each call returns an auth error explaining how to add the env block.

## Add your API key

Public REST tools and the public ticker WebSocket tool work without a key. The 12 secure REST tools and the 2 private WebSocket tools need a Bitkub API key + secret in your MCP client config's `env` block — **never** as tool arguments. The LLM never sees the secret.

### 1. Generate a key on Bitkub

1. Go to <https://www.bitkub.com/en/api-management> and log in if prompted.
2. Click **Create new API key**.
3. **Recommended: enable read-only permissions only** — uncheck Trade and Withdraw scopes. The server only exposes read-only endpoints, so giving the key write scopes is wasted attack surface.
4. Copy the **API Key** and **API Secret** before closing the dialog (the secret is shown only once).

### 2. Paste into the env block

Replace the two `your_..._here` placeholders in whichever Install option you picked above with the real key + secret. Save, restart the MCP client.

### 3. Verify the key actually works

If you have the source checked out:

```bash
cd /path/to/bitkub-trading-mcp
eval "$(bun -e 'const c=await Bun.file(`${process.env.HOME}/.claude.json`).json();const e=c.mcpServers[`bitkub-trading-mcp`].env;console.log(`export BITKUB_API_KEY=${e.BITKUB_API_KEY}\nexport BITKUB_API_SECRET=${e.BITKUB_API_SECRET}`)')" && bun scripts/test-auth.ts
```

`PASS` means the key + signing path is working end-to-end against Bitkub.

Otherwise, just ask Claude *"What's in my Bitkub wallet?"* — if it returns balances, the key works.

## Public tools

| Tool                | Endpoint                                                 |
| ------------------- | -------------------------------------------------------- |
| `bitkub_status`     | `GET /api/status`                                        |
| `bitkub_servertime` | `GET /api/v3/servertime` (ms)                            |
| `bitkub_symbols`    | `GET /api/v3/market/symbols`                             |
| `bitkub_ticker`     | `GET /api/v3/market/ticker?sym=`                         |
| `bitkub_bids`       | `GET /api/v3/market/bids?sym=&lmt=`                      |
| `bitkub_asks`       | `GET /api/v3/market/asks?sym=&lmt=`                      |
| `bitkub_depth`      | `GET /api/v3/market/depth?sym=&lmt=`                     |
| `bitkub_trades`     | `GET /api/v3/market/trades?sym=&lmt=`                    |
| `bitkub_tv_history` | `GET /tradingview/history?symbol=&resolution=&from=&to=` |

## Secure tools (read-only, auth required)

Bitkub v4 is used wherever it has an equivalent; v3 endpoints are kept only where v4 has not yet shipped one. v4 uses GET with query params; v3 mostly used POST with body. Auth signing is identical for v3 and v4.

| Tool                          | Ver | Method | Endpoint                              | Args (zod-validated)                                                |
| ----------------------------- | --- | ------ | ------------------------------------- | ------------------------------------------------------------------- |
| `bitkub_balances`             | v4  | GET    | `/api/v4/wallet/balances`             | `segment?` (`"funding"`)                                            |
| `bitkub_crypto_addresses`     | v4  | GET    | `/api/v4/crypto/addresses`            | `page?` (≥1), `limit?` (1–200), `symbol?`, `network?`, `memo?`      |
| `bitkub_crypto_deposits`      | v4  | GET    | `/api/v4/crypto/deposits`             | `page?`, `limit?` (1–200), `symbol?`, `status?`, `created_start?`, `created_end?` (ISO 8601) |
| `bitkub_crypto_withdraws`     | v4  | GET    | `/api/v4/crypto/withdraws`            | same shape as `bitkub_crypto_deposits` (read-only history)          |
| `bitkub_fiat_accounts`        | v4  | GET    | `/api/v4/fiat/accounts`               | `page?` (1–100), `limit?` (1–100) — must be paired                  |
| `bitkub_fiat_deposits`        | v4  | GET    | `/api/v4/fiat/deposit/history`        | `page?`, `limit?` (1–100) — must be paired                          |
| `bitkub_fiat_withdraws`       | v4  | GET    | `/api/v4/fiat/withdraw/history`       | `page?`, `limit?` (1–100) — must be paired (read-only history)      |
| `bitkub_my_open_orders`       | v3  | GET    | `/api/v3/market/my-open-orders`       | `sym`                                                               |
| `bitkub_my_order_history`     | v3  | GET    | `/api/v3/market/my-order-history`     | `sym`, `p?`, `lmt?`, `start?`, `end?`                               |
| `bitkub_order_info`           | v3  | GET    | `/api/v3/market/order-info`           | `sym`, `id`, `sd`, `hash?`                                          |
| `bitkub_user_limits`          | v3  | POST   | `/api/v3/user/limits`                 | (none)                                                              |
| `bitkub_user_trading_credits` | v3  | POST   | `/api/v3/user/trading-credits`        | (none)                                                              |

**Auth signing** (v3 and v4): `X-BTK-APIKEY`, `X-BTK-TIMESTAMP` (Unix ms), `X-BTK-SIGN` = HMAC-SHA256 of `{ts}{METHOD}{path}{?query | body}`, hex lowercase. For POSTs the exact JSON bytes sent on the wire are signed.

References: <https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api.md> · <https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api-v4.md>

## WebSocket tools (snapshot)

Each call opens a WebSocket, collects events for a bounded duration, then closes. Stateless — no long-lived subscriptions, no MCP notifications.

| Tool                         | Stream                          | Auth     | Default / max duration |
| ---------------------------- | ------------------------------- | -------- | ---------------------- |
| `bitkub_ws_ticker_snapshot`  | `market.ticker.<sym>` (public)  | none     | 10 s / 60 s            |
| `bitkub_ws_order_updates`    | `order_update` (private)        | required | 30 s / 120 s           |
| `bitkub_ws_match_updates`    | `match_update` (private)        | required | 30 s / 120 s           |

Args (every tool):

- `duration_ms?` — int, milliseconds. Defaults and caps as in the table above.
- `bitkub_ws_ticker_snapshot.sym` — required (e.g. `btc_thb`).
- `bitkub_ws_order_updates.sym` / `bitkub_ws_match_updates.sym` — optional post-filter on `data.symbol`.

Response shape:

```json
{
  "events": [/* raw Bitkub payloads, in receive order */],
  "count": 0,
  "duration_ms_actual": 30000,
  "stream": "order_update",
  "started_at": "2026-05-10T17:00:00.000Z",
  "ended_at":   "2026-05-10T17:00:30.000Z"
}
```

If the WS closes before the window ends, the response also includes `closed_early: true` and `closed_reason: "..."`.

**Race-condition note:** the private streams only deliver events that occur AFTER `subscribe` is sent. If you want to observe an order's full lifecycle, call `bitkub_ws_order_updates` *in parallel* with the order placement — or call `bitkub_order_info` afterward for the authoritative final state.

**Concurrency cap:** Bitkub permits at most 5 concurrent private WebSocket connections per API key. The server detects "too many concurrent" closes and surfaces them with a clear message.

**Excluded streams (intentional):** the public `market.trade.*` channel (Bitkub deprecates it 2026-05-18) and the public orderbook channel (uses numeric `pairing_id` instead of symbol; REST `bitkub_depth` is a better fit).

References: <https://github.com/bitkub/bitkub-official-api-docs/blob/master/websocket-api.md> · <https://github.com/bitkub/bitkub-official-api-docs/blob/master/private-websocket.md>

## Usage examples

Tools are invoked by Claude based on what you ask in plain English. The "you say" rows show the kind of prompt that triggers the tool; the "tool" rows show what gets called under the hood (you can verify with `/mcp` → tool history). All examples assume the server is registered and connected.

### Public REST — market data (no key needed)

| What you say | Tool called | Notes |
|---|---|---|
| *"Is Bitkub's API up right now?"* | `bitkub_status` | Health-check the platform before placing orders manually. |
| *"What's the current BTC/THB price?"* | `bitkub_ticker` with `sym=btc_thb` | Single-shot point-in-time price + 24h change. |
| *"Show me top 10 buy orders for ETH/THB"* | `bitkub_bids` with `sym=eth_thb, lmt=10` | Open buy orders (bids). Use `bitkub_asks` for sells. |
| *"What's the order book depth for BTC/THB, top 20 levels?"* | `bitkub_depth` with `sym=btc_thb, lmt=20` | Aggregated bids/asks — best for spread analysis. |
| *"Last 50 trades on USDT/THB"* | `bitkub_trades` with `sym=usdt_thb, lmt=50` | Recent matched trades (timestamp, price, side, amount). |
| *"List all trading pairs available on Bitkub"* | `bitkub_symbols` | Useful when you don't know the exact `sym` string. |
| *"Get BTC/THB hourly candles for the last 24 hours"* | `bitkub_tv_history` with `symbol=BTC_THB, resolution=60, from=<ts>, to=<ts>` | OHLCV for charting. Resolutions: `1, 5, 15, 60, 240, 1D`. |
| *"What's the server's current time?"* | `bitkub_servertime` | Sanity-check clock skew if signed requests fail. |

### Private REST — your account (key required, read-only)

| What you say | Tool called | Notes |
|---|---|---|
| *"What's in my Bitkub wallet?"* | `bitkub_balances` | v4 endpoint. Returns currency, available, reserved, total per asset. |
| *"List my open orders for BTC/THB"* | `bitkub_my_open_orders` with `sym=btc_thb` | Currently active orders only. |
| *"Show my last 20 BTC/THB orders, including filled/cancelled"* | `bitkub_my_order_history` with `sym=btc_thb, lmt=20` | Full history with pagination. |
| *"Tell me the status of order ID 123456 (buy side)"* | `bitkub_order_info` with `sym=btc_thb, id=123456, sd=buy` | Authoritative current state of a specific order. |
| *"What are my user trading limits?"* | `bitkub_user_limits` | Daily / monthly THB throughput caps. |
| *"How much trading credit do I have?"* | `bitkub_user_trading_credits` | Bitkub trading-credit balance (used for fee discounts). |
| *"List my saved crypto deposit addresses"* | `bitkub_crypto_addresses` with `limit=50` | v4. Filter by `symbol`, `network`, `memo`. |
| *"Show my crypto deposits in the last 30 days"* | `bitkub_crypto_deposits` with `created_start=2026-04-10T00:00:00Z, limit=100` | v4 with date filtering. 90-day max window. |
| *"Show my crypto withdrawals this month"* | `bitkub_crypto_withdraws` with `created_start=2026-05-01T00:00:00Z` | v4 same shape as deposits. |
| *"List my registered bank accounts"* | `bitkub_fiat_accounts` with `page=1, limit=20` | **page+limit must be paired** — provide both or neither. |
| *"My fiat deposit history"* | `bitkub_fiat_deposits` with `page=1, limit=20` | Same pairing rule. |
| *"My fiat withdrawal history"* | `bitkub_fiat_withdraws` with `page=1, limit=20` | Same pairing rule. |

### Public WebSocket — live ticker (no key)

| What you say | Tool called | Notes |
|---|---|---|
| *"Sample BTC/THB price for 10 seconds. Is it trending up or down?"* | `bitkub_ws_ticker_snapshot` with `sym=btc_thb, duration_ms=10000` | Returns array of ticker updates; Claude computes first-vs-last delta. |
| *"Watch ETH/THB for 30s and tell me the volatility"* | `bitkub_ws_ticker_snapshot` with `sym=eth_thb, duration_ms=30000` | Useful before market-buying so you see actual spread movement. |
| *"Did BTC just spike? Sample for 15 seconds."* | `bitkub_ws_ticker_snapshot` with `sym=btc_thb, duration_ms=15000` | Catches micro-movements REST polling would miss. |

Caveat: Bitkub sometimes closes the public ticker stream after just a few seconds during low activity. The response will include `closed_early: true` when that happens — Claude can rerun if needed.

### Private WebSocket — order / match streams (key required)

| What you say | Tool called | Notes |
|---|---|---|
| *"Watch my account for 60 seconds and report any order events"* | `bitkub_ws_order_updates` with `duration_ms=60000` | Captures `new → open → partial_filled → filled → canceled` transitions. |
| *"Watch only BTC/THB order updates for 90s"* | `bitkub_ws_order_updates` with `sym=btc_thb, duration_ms=90000` | `sym` post-filters events by `data.symbol`. |
| *"Wait 60 seconds and tell me what trades I executed"* | `bitkub_ws_match_updates` with `duration_ms=60000` | Each match = one fill. Aggregates into avg fill price + total fees. |
| *"Compare maker vs taker fill rate over the next 90s"* | `bitkub_ws_match_updates` with `duration_ms=90000` | `is_maker` field on each match. |

**Race-condition recipe.** Private WS only delivers events that occur AFTER subscribe — to capture an order's full lifecycle:

> *"Place a BTC limit buy at 2.7M for 0.0001 BTC, and IN PARALLEL watch order_updates for 60 seconds. Then call `bitkub_order_info` to confirm final state."*

In one Claude turn, all three tool calls fire in parallel. The WS captures most lifecycle events; the REST `order_info` call provides the authoritative final state in case any early events were missed.

> Note: This server does NOT include order placement — you'd add a separate trading server (or place manually on Bitkub) for the place step. The watch + verify pattern still works against an order placed by other means.

### Combined workflows (multiple tools in one prompt)

| Workflow | Tools used (parallel) |
|---|---|
| *"Show me BTC/THB depth, last 50 trades, and watch ticker for 10s. Tell me if it's a good time to buy."* | `bitkub_depth` + `bitkub_trades` + `bitkub_ws_ticker_snapshot` |
| *"Audit my last 24h: balances now, all crypto deposits since yesterday, and any open orders."* | `bitkub_balances` + `bitkub_crypto_deposits` (with `created_start`) + `bitkub_my_open_orders` (per symbol) |
| *"My order is stuck at 'open' in the UI. Get its REST state AND watch order_updates for 30s to see if anything moves."* | `bitkub_order_info` + `bitkub_ws_order_updates` |

## Security

- **Read-only by design.** This server intentionally does NOT implement order placement, order cancellation, withdrawal initiation, or address generation. Only data-retrieval endpoints are exposed.
- **Use a read-only Bitkub API key.** Bitkub's API-key permission model lets you scope a key to read-only operations — please do that. The server will refuse nothing on its own, but a least-privilege key gives you a hard guarantee at the exchange level even if anything misbehaves.
- **Credentials are never accepted as tool arguments.** They are read from `process.env` only, sourced from the MCP client's `env` block. The LLM cannot see the secret.
- **Secrets aren't logged.** Diagnostics on stderr only mention whether creds are present, never their values.
- Rotate keys by updating the `env` block in your client config and restarting the MCP client; no server-code change required.

## Notes

- All responses pass Bitkub's JSON through unchanged (no field remapping).
- Bitkub envelope errors (`error != 0`) are surfaced as MCP tool errors with the original error code.
- HTTP non-2xx is surfaced with the status and response body.
- Diagnostics are written to **stderr** only — stdout is reserved for the MCP transport.
