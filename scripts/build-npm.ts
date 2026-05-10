#!/usr/bin/env bun
/**
 * Build a Node.js-compatible bundle for npm publish.
 * Output: dist/index.js — single file, all deps bundled, with `#!/usr/bin/env node`
 * shebang + executable bit so it can be invoked via `npx bitkub-trading-mcp`.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = resolve(root, "dist/index.js");

const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: resolve(root, "dist"),
  naming: "index.js",
  target: "node",
  format: "esm",
  minify: true,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const original = readFileSync(out, "utf8");
// Strip any pre-existing shebang from source/bun output, then prepend node shebang.
const stripped = original.startsWith("#!") ? original.replace(/^#!.*\n/, "") : original;
writeFileSync(out, `#!/usr/bin/env node\n${stripped}`);
chmodSync(out, 0o755);

const sizeKb = Math.round(Buffer.byteLength(stripped) / 1024);
process.stderr.write(`built ${out} (${sizeKb} KB) with node shebang + 0755\n`);
