#!/usr/bin/env node
// Bundle the MCP server into a single self-contained .mjs file.
// Usage: node scripts/bundle.mjs [--copy-to <path>]
//
// The bundle includes all dependencies except Node.js builtins.
// Output: dist/razz-mcp-server.mjs
//
// Optional: --copy-to copies the bundle to another directory (e.g. razz-agents/lib/)

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUTFILE = resolve(ROOT, "dist", "razz-mcp-server.cjs");

// Parse --copy-to flag
let copyTo = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--copy-to" && args[i + 1]) {
    copyTo = resolve(args[i + 1]);
  }
}

console.log("Bundling MCP server...");

await build({
  entryPoints: [resolve(ROOT, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: OUTFILE,
  banner: {
    js: "// Razz MCP Server - bundled, self-contained\n// https://razz.games",
  },
  // Bundle everything except Node.js builtins
  packages: "bundle",
  minify: false, // keep readable for trust/auditability
  sourcemap: false,
  logLevel: "info",
});

console.log(`Bundle written to: ${OUTFILE}`);

// Copy to target if specified
if (copyTo) {
  mkdirSync(dirname(copyTo), { recursive: true });
  const dest = copyTo.endsWith(".cjs") ? copyTo : resolve(copyTo, "razz-mcp-server.cjs");
  copyFileSync(OUTFILE, dest);
  console.log(`Copied to: ${dest}`);
}

// Auto-copy to razz-agents if the sibling repo exists
import { existsSync } from "node:fs";
const RAZZ_AGENTS_LIB = resolve(ROOT, "../../../razz-agents/lib");
if (!copyTo && existsSync(RAZZ_AGENTS_LIB)) {
  const dest = resolve(RAZZ_AGENTS_LIB, "razz-mcp-server.cjs");
  copyFileSync(OUTFILE, dest);
  console.log(`Auto-copied to: ${dest}`);
}

// Auto-copy to public MCP repo if it exists
const PUBLIC_REPO_DIST = resolve(ROOT, "../../../razz-mcp/dist");
if (!copyTo && existsSync(PUBLIC_REPO_DIST)) {
  const dest = resolve(PUBLIC_REPO_DIST, "razz-mcp-server.cjs");
  copyFileSync(OUTFILE, dest);
  console.log(`Auto-copied to: ${dest}`);
}
