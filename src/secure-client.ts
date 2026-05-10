/**
 * Bitkub v3 SECURE-ENDPOINT client (read-only usage).
 *
 * Auth (Bitkub v3, per official docs):
 *   Headers on every secure call:
 *     X-BTK-APIKEY     — your API key
 *     X-BTK-TIMESTAMP  — current Unix timestamp in MILLISECONDS
 *     X-BTK-SIGN       — HMAC-SHA256(secret, payload), hex lowercase
 *   Plus, for POST requests: Content-Type: application/json
 *
 *   Signature payload string (concatenated, no separators):
 *     {timestamp}{METHOD}{path}{queryStringWithLeadingQuestionMark | rawJsonBody}
 *
 *   GET with query params  -> "{ts}GET{path}?{querystring}"
 *   GET without params     -> "{ts}GET{path}"
 *   POST with body         -> "{ts}POST{path}{exactBytesSentOnTheWire}"
 *   POST without params    -> "{ts}POST{path}{}"   (Bitkub expects body "{}")
 *
 * IMPORTANT: For POST we sign and SEND the exact same JSON string. Re-stringifying
 * for the signature would risk whitespace/key-order drift.
 *
 * Credentials are read from process.env on each call so an operator can rotate
 * keys (by restarting the MCP client) without rebuilding the server.
 *
 * Envelope semantics (same as public client):
 *   HTTP non-2xx        -> throw BitkubApiError(status, body)
 *   HTTP 200, error: 0  -> return body
 *   HTTP 200, error != 0 -> throw BitkubApiError with bitkubErrorCode set
 */

import { createHmac } from "node:crypto";
import {
  BITKUB_BASE_URL,
  BitkubApiError,
  buildQuery,
  type QueryParams,
} from "./bitkub-client.ts";

export class BitkubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitkubAuthError";
  }
}

const MISSING_CREDS_MESSAGE =
  "BITKUB_API_KEY/SECRET not set. Add them under mcpServers.bitkub-trading-mcp.env in ~/.claude.json and restart Claude Code.";

/** Reads creds from env each call; throws BitkubAuthError if either is missing/empty. */
function readCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.BITKUB_API_KEY?.trim();
  const apiSecret = process.env.BITKUB_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new BitkubAuthError(MISSING_CREDS_MESSAGE);
  }
  return { apiKey, apiSecret };
}

/** HMAC-SHA256 of `payload` keyed by `secret`, returned as lowercase hex. */
function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Build a query string WITH leading `?` if non-empty, else `""`. */
function queryStringWithMark(params?: QueryParams): string {
  return buildQuery(params); // buildQuery already returns "?..." or ""
}

interface BitkubFetchOptions {
  method: "GET" | "POST";
  path: string;
  /** Query params for GET. Ignored for POST. */
  query?: QueryParams;
  /** Body object for POST. Ignored for GET. `undefined` -> "{}". */
  body?: Record<string, unknown>;
}

/** Drop keys whose value is undefined or null (so we don't send `"p": null`). */
function compactBody(
  body: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!body) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

async function bitkubSecureFetch(opts: BitkubFetchOptions): Promise<unknown> {
  const { apiKey, apiSecret } = readCredentials();

  const timestamp = Date.now().toString(); // milliseconds
  const url = `${BITKUB_BASE_URL}${opts.path}`;

  let payload: string;
  let fetchInit: RequestInit;

  if (opts.method === "GET") {
    const qs = queryStringWithMark(opts.query); // "?a=b" or ""
    // Bitkub quirk: v4 /api/v4/fiat/* endpoints sign the path WITHOUT the
    // query string, even though the URL still includes it. v4 crypto and v3
    // endpoints sign with the query string. Verified against all three fiat
    // routes (accounts, deposit/history, withdraw/history) — server returns
    // "Invalid X-BTK-SIGN" if you include the qs in the signature payload.
    const isFiatV4 = opts.path.startsWith("/api/v4/fiat/");
    const signedQs = isFiatV4 ? "" : qs;
    payload = `${timestamp}GET${opts.path}${signedQs}`;
    fetchInit = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-BTK-APIKEY": apiKey,
        "X-BTK-TIMESTAMP": timestamp,
        "X-BTK-SIGN": sign(apiSecret, payload),
      },
    };
    // url gets the (full) query string for the actual request:
    return doFetch(url + qs, fetchInit);
  }

  // POST
  const bodyObj = compactBody(opts.body);
  // Sign the EXACT bytes we send. JSON.stringify with no spaces, fixed key order
  // (Object.entries is insertion-order; compactBody preserves that).
  const bodyString = JSON.stringify(bodyObj);
  payload = `${timestamp}POST${opts.path}${bodyString}`;
  fetchInit = {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BTK-APIKEY": apiKey,
      "X-BTK-TIMESTAMP": timestamp,
      "X-BTK-SIGN": sign(apiSecret, payload),
    },
    body: bodyString,
  };
  return doFetch(url, fetchInit);
}

/** Fetch + envelope handling, mirrors the public client's semantics. */
async function doFetch(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BitkubApiError(`Network error calling ${url}: ${msg}`, {
      status: 0,
    });
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) {
      throw new BitkubApiError(
        `Bitkub HTTP ${res.status} for ${url}: ${text.slice(0, 500)}`,
        { status: res.status, body: text },
      );
    }
    return text;
  }

  if (!res.ok) {
    throw new BitkubApiError(
      `Bitkub HTTP ${res.status} for ${url}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
      { status: res.status, body },
    );
  }

  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "error" in (body as Record<string, unknown>)
  ) {
    const errCode = (body as Record<string, unknown>).error;
    if (typeof errCode === "number" && errCode !== 0) {
      throw new BitkubApiError(
        `Bitkub returned error code ${errCode} for ${url}: ${JSON.stringify(body)}`,
        { status: res.status, bitkubErrorCode: errCode, body },
      );
    }
  }

  return body;
}

/** Public API: GET a secure v3 endpoint with optional query params. */
export function bitkubSecureGet(
  path: string,
  query?: QueryParams,
): Promise<unknown> {
  return bitkubSecureFetch({ method: "GET", path, query });
}

/** Public API: POST a secure v3 endpoint with optional JSON body. */
export function bitkubSecurePost(
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  return bitkubSecureFetch({ method: "POST", path, body });
}
