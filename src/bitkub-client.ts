/**
 * Minimal fetch wrapper for Bitkub PUBLIC (non-secure) REST endpoints.
 *
 * Error semantics (Bitkub):
 *  - HTTP non-2xx        -> throw with status + body
 *  - HTTP 200, error: 0  -> success (return body)
 *  - HTTP 200, error != 0 -> throw including Bitkub error code
 *
 * Note: TradingView-format endpoints (e.g. /tradingview/history) do NOT use
 * the {error, result} envelope; they return their own shape (e.g. {s:"ok",...}).
 * We only enforce the envelope when an `error` field is present on the body.
 */

export const BITKUB_BASE_URL = "https://api.bitkub.com";

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

/** Build a query string, skipping null/undefined values. */
export function buildQuery(params: QueryParams | undefined): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export class BitkubApiError extends Error {
  public readonly status: number;
  public readonly bitkubErrorCode?: number;
  public readonly body?: unknown;

  constructor(
    message: string,
    opts: { status: number; bitkubErrorCode?: number; body?: unknown },
  ) {
    super(message);
    this.name = "BitkubApiError";
    this.status = opts.status;
    this.bitkubErrorCode = opts.bitkubErrorCode;
    this.body = opts.body;
  }
}

/**
 * GET a public Bitkub endpoint and return parsed JSON.
 * Throws BitkubApiError on HTTP failure or Bitkub envelope error.
 */
export async function bitkubGet(
  path: string,
  params?: QueryParams,
): Promise<unknown> {
  const url = `${BITKUB_BASE_URL}${path}${buildQuery(params)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
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
    // Non-JSON body
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

  // Envelope check: only when body is an object with `error` field present.
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
