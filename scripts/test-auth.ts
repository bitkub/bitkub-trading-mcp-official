#!/usr/bin/env bun
/**
 * One-shot credential check.
 * Reads BITKUB_API_KEY / BITKUB_API_SECRET from env, calls v4 /api/v4/wallet/balances
 * (GET), prints PASS or FAIL with the underlying error. Verifies v4 GET signing.
 */
import { bitkubSecureGet, BitkubAuthError } from "../src/secure-client.ts";
import { BitkubApiError } from "../src/bitkub-client.ts";

try {
  const wallet = await bitkubSecureGet("/api/v4/wallet/balances");
  console.log("PASS — credentials accepted by Bitkub v4.");
  // v4 result shape: { error: 0, result: [...] } where each item is an asset row.
  const result = (wallet as { result?: unknown }).result;
  if (Array.isArray(result)) {
    const nonZero = result.filter((row) => {
      const r = row as Record<string, unknown>;
      const total = Number(r.total ?? r.available ?? 0);
      return total > 0;
    });
    if (nonZero.length === 0) {
      console.log("Wallet is empty (all zero balances). Auth still worked.");
    } else {
      console.log(`Non-zero balances (${nonZero.length}):`);
      for (const row of nonZero) {
        const r = row as Record<string, unknown>;
        console.log(`  ${r.symbol ?? r.asset ?? "?"}: total=${r.total ?? "?"} available=${r.available ?? "?"}`);
      }
    }
  } else {
    const raw = JSON.stringify(result ?? wallet);
    console.log("Result (raw, first 400 chars):", raw.slice(0, 400));
  }
  process.exit(0);
} catch (e) {
  if (e instanceof BitkubAuthError) {
    console.error("FAIL — credentials missing in env.");
    console.error(e.message);
    process.exit(2);
  }
  if (e instanceof BitkubApiError) {
    console.error("FAIL — Bitkub rejected the request.");
    console.error(`status=${e.status} bitkubErrorCode=${e.bitkubErrorCode ?? "n/a"}`);
    console.error(e.message);
    process.exit(3);
  }
  console.error("FAIL — unexpected error:", e);
  process.exit(4);
}
