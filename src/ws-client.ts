/**
 * Bitkub WebSocket "snapshot" collector.
 *
 * Pattern: open WS → (auth + subscribe if private) → buffer events for a bounded
 * duration → unsubscribe + close → return events. Stateless. One WS per call.
 *
 * Public ticker stream (no auth):
 *   wss://api.bitkub.com/websocket-api/market.ticker.<sym>
 *   Subscription is implicit in the URL; just open, listen, close.
 *
 * Private stream (auth required):
 *   wss://stream.bitkub.com/v3/private
 *   Required HTTP upgrade header: User-Agent (Bitkub rejects without it).
 *   Auth message:    {"event":"auth","data":{"X-BTK-APIKEY":..,"X-BTK-SIGN":..,"X-BTK-TIMESTAMP":..}}
 *     - Signature payload is the timestamp ALONE (NOT the REST concat).
 *   Auth response:   {"event":"auth","code":"200",...}  (or "401" + message on failure)
 *   Subscribe:       {"event":"subscribe","channel":"order_update" | "match_update"}
 *   Heartbeat rule:  if duration > 4 minutes, send {"event":"ping"} every 240s.
 *                    Our caps are <=120s, so we never need to ping in practice.
 *
 * Why `ws` (not Bun's built-in WebSocket)?
 *   We ship an npm bundle targeting Node ≥18, and Node only got a built-in
 *   undici-based WebSocket as of Node 22. The `ws` package works on both Bun
 *   and Node ≥18, AND it lets us set custom Upgrade headers (User-Agent),
 *   which the WHATWG WebSocket constructor cannot.
 */

import { createHmac } from "node:crypto";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BitkubWsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitkubWsError";
  }
}

export class BitkubWsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitkubWsAuthError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_BASE = "wss://api.bitkub.com/websocket-api";
const PRIVATE_URL = "wss://stream.bitkub.com/v3/private";
const USER_AGENT = "bitkub-trading-mcp/1.0.2";
const OPEN_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 240_000; // only relevant if a future tool exceeds 4 min

const MISSING_CREDS_MESSAGE =
  "BITKUB_API_KEY/SECRET not set. Add them under mcpServers.bitkub-trading-mcp.env in ~/.claude.json and restart Claude Code.";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type WsEvent = Record<string, unknown>;

export interface WsCollectResult {
  events: WsEvent[];
  count: number;
  duration_ms_actual: number;
  stream: string;
  started_at: string;
  ended_at: string;
  /** Set when the WS closed before the duration elapsed. */
  closed_early?: boolean;
  /** Optional explanation of an early close (close code + reason). */
  closed_reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.BITKUB_API_KEY?.trim();
  const apiSecret = process.env.BITKUB_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new BitkubWsAuthError(MISSING_CREDS_MESSAGE);
  }
  return { apiKey, apiSecret };
}

/** Wait for the WS to become OPEN, or reject on timeout/error. */
function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
      ws.removeListener("close", onClose);
      fn();
    };
    const onOpen = () => settle(() => resolve());
    const onError = (err: Error) =>
      settle(() => reject(new BitkubWsError(`WebSocket error: ${err.message}`)));
    const onClose = (code: number, reasonBuf: Buffer) =>
      settle(() =>
        reject(
          new BitkubWsError(
            `WebSocket closed before open: ${code} ${reasonBuf.toString() || ""}`.trim(),
          ),
        ),
      );
    const timer = setTimeout(
      () => settle(() => reject(new BitkubWsError("Connection timeout"))),
      timeoutMs,
    );
    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

/** Parse a raw frame as JSON, or return null on parse failure. */
function tryParse(raw: WebSocket.RawData): WsEvent | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString("utf8")
            : (raw as Buffer).toString("utf8");
    if (!text) return null;
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as WsEvent) : null;
  } catch {
    return null;
  }
}

/** Best-effort send; swallow errors. */
function safeSend(ws: WebSocket, payload: object): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch {
    // ignore
  }
}

/** Best-effort close; swallow errors. */
function safeClose(ws: WebSocket): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "snapshot complete");
    }
  } catch {
    // ignore
  }
}

/**
 * Detect Bitkub's "too many concurrent connections" close. The exchange
 * uses 1008 (policy violation) for that; we also surface any explicit
 * mention of concurrency in the close reason.
 */
function isConcurrencyClose(code: number, reason: string): boolean {
  if (code === 1008) return true;
  const r = reason.toLowerCase();
  return r.includes("too many") || r.includes("concurrent");
}

// ---------------------------------------------------------------------------
// Public ticker snapshot (no auth)
// ---------------------------------------------------------------------------

/**
 * Open the public ticker WS for `sym`, collect events for `durationMs`,
 * close, and return the buffered events.
 *
 * `sym` is lowercase like `btc_thb`. The Bitkub URL convention swaps
 * base/quote to `<quote>_<base>` (e.g. `thb_btc`); we do that swap here.
 */
export async function wsCollectPublicTicker(
  sym: string,
  durationMs: number,
): Promise<WsCollectResult> {
  const [base, quote] = sym.split("_");
  if (!base || !quote) {
    throw new BitkubWsError(
      `Invalid sym '${sym}': expected lowercase base_quote (e.g. 'btc_thb').`,
    );
  }
  const wsSym = `${quote}_${base}`; // Bitkub URL is quote_base
  const channel = `market.ticker.${wsSym}`;
  const url = `${PUBLIC_BASE}/${channel}`;

  const ws = new WebSocket(url, {
    headers: { "User-Agent": USER_AGENT },
    handshakeTimeout: OPEN_TIMEOUT_MS,
  });

  await waitForOpen(ws, OPEN_TIMEOUT_MS);

  const startedAtMs = Date.now();
  const events: WsEvent[] = [];
  let closedEarly = false;
  let closedReason: string | undefined;

  await new Promise<void>((resolve) => {
    const finish = () => {
      ws.removeAllListeners("message");
      ws.removeAllListeners("close");
      ws.removeAllListeners("error");
      resolve();
    };

    const timer = setTimeout(() => {
      safeClose(ws);
      finish();
    }, durationMs);

    ws.on("message", (raw) => {
      const ev = tryParse(raw);
      if (!ev) {
        process.stderr.write("[ws] dropped malformed ticker frame\n");
        return;
      }
      events.push(ev);
    });
    ws.on("error", (err) => {
      process.stderr.write(`[ws] ticker error: ${err.message}\n`);
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString() || "";
      if (Date.now() < startedAtMs + durationMs) {
        closedEarly = true;
        closedReason = `code=${code}${reason ? ` reason=${reason}` : ""}`;
        process.stderr.write(`[ws] ticker closed early: ${closedReason}\n`);
      }
      clearTimeout(timer);
      finish();
    });
  });

  const endedAtMs = Date.now();
  return {
    events,
    count: events.length,
    duration_ms_actual: endedAtMs - startedAtMs,
    stream: channel,
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: new Date(endedAtMs).toISOString(),
    ...(closedEarly ? { closed_early: true, closed_reason: closedReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Private stream snapshot (auth required)
// ---------------------------------------------------------------------------

interface PrivateAuthResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/** Send the auth frame and resolve when Bitkub acks (or rejects). */
function authenticatePrivate(
  ws: WebSocket,
  apiKey: string,
  apiSecret: string,
): Promise<PrivateAuthResult> {
  const ts = Date.now().toString();
  // IMPORTANT: private WS signs the timestamp ALONE — different from REST.
  const sig = createHmac("sha256", apiSecret).update(ts).digest("hex");
  const authFrame = {
    event: "auth",
    data: {
      "X-BTK-APIKEY": apiKey,
      "X-BTK-SIGN": sig,
      "X-BTK-TIMESTAMP": ts,
    },
  };

  return new Promise<PrivateAuthResult>((resolve, reject) => {
    let settled = false;
    const settle = (val: PrivateAuthResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeListener("message", onMessage);
      ws.removeListener("error", onError);
      ws.removeListener("close", onClose);
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      const ev = tryParse(raw);
      if (!ev || ev.event !== "auth") return;
      const code =
        typeof ev.code === "string"
          ? ev.code
          : typeof ev.code === "number"
            ? String(ev.code)
            : undefined;
      const message = typeof ev.message === "string" ? ev.message : undefined;
      settle({ ok: code === "200", code, message });
    };
    const onError = (err: Error) =>
      settle(new BitkubWsError(`WS error during auth: ${err.message}`));
    const onClose = (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString() || "";
      if (isConcurrencyClose(code, reason)) {
        settle(
          new BitkubWsError(
            `Too many concurrent connections (Bitkub max 5/API key); wait or close other connections.`,
          ),
        );
        return;
      }
      settle(
        new BitkubWsError(
          `WS closed during auth: code=${code}${reason ? ` reason=${reason}` : ""}`,
        ),
      );
    };
    const timer = setTimeout(
      () => settle(new BitkubWsAuthError("Auth timed out (5s)")),
      AUTH_TIMEOUT_MS,
    );

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);

    safeSend(ws, authFrame);
  });
}

/**
 * Open the private WS, authenticate, subscribe to `channel`, collect every
 * event whose `event === channel` for `durationMs`, then unsubscribe + close.
 *
 * Duration starts from the moment the subscribe frame is SENT (per spec —
 * caller wants real wall-clock window after subscription is requested).
 */
export async function wsCollectPrivate(
  channel: "order_update" | "match_update",
  durationMs: number,
): Promise<WsCollectResult> {
  const { apiKey, apiSecret } = readCredentials();

  const ws = new WebSocket(PRIVATE_URL, {
    headers: { "User-Agent": USER_AGENT },
    handshakeTimeout: OPEN_TIMEOUT_MS,
  });

  await waitForOpen(ws, OPEN_TIMEOUT_MS);

  const auth = await authenticatePrivate(ws, apiKey, apiSecret);
  if (!auth.ok) {
    safeClose(ws);
    const detail = `${auth.code ?? "?"}${auth.message ? ` ${auth.message}` : ""}`;
    throw new BitkubWsAuthError(`Bitkub WS auth failed: ${detail.trim()}`);
  }

  // Subscribe — no documented ack; start the clock as we send.
  safeSend(ws, { event: "subscribe", channel });
  const startedAtMs = Date.now();

  const events: WsEvent[] = [];
  let closedEarly = false;
  let closedReason: string | undefined;

  await new Promise<void>((resolve) => {
    const finish = () => {
      ws.removeAllListeners("message");
      ws.removeAllListeners("close");
      ws.removeAllListeners("error");
      clearInterval(pinger);
      resolve();
    };

    const timer = setTimeout(() => {
      // best-effort unsubscribe, then close
      safeSend(ws, { event: "unsubscribe", channel });
      safeClose(ws);
      finish();
    }, durationMs);

    // Heartbeat: only matters above 4 min. Our cap is <=120s, but keep the
    // logic so a future maintainer raising the cap doesn't drop heartbeats.
    const pinger = setInterval(() => {
      safeSend(ws, { event: "ping" });
    }, PING_INTERVAL_MS);

    ws.on("message", (raw) => {
      const ev = tryParse(raw);
      if (!ev) {
        process.stderr.write(`[ws] dropped malformed ${channel} frame\n`);
        return;
      }
      // Skip ping echoes and any non-matching event frames (auth/subscribe acks).
      if (ev.event === "ping") return;
      if (ev.event !== channel) return;
      events.push(ev);
    });
    ws.on("error", (err) => {
      process.stderr.write(`[ws] ${channel} error: ${err.message}\n`);
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString() || "";
      if (Date.now() < startedAtMs + durationMs) {
        closedEarly = true;
        if (isConcurrencyClose(code, reason)) {
          closedReason = `Too many concurrent connections (Bitkub max 5/API key); wait or close other connections.`;
        } else {
          closedReason = `code=${code}${reason ? ` reason=${reason}` : ""}`;
        }
        process.stderr.write(`[ws] ${channel} closed early: ${closedReason}\n`);
      }
      clearTimeout(timer);
      finish();
    });
  });

  const endedAtMs = Date.now();
  return {
    events,
    count: events.length,
    duration_ms_actual: endedAtMs - startedAtMs,
    stream: channel,
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: new Date(endedAtMs).toISOString(),
    ...(closedEarly ? { closed_early: true, closed_reason: closedReason } : {}),
  };
}
