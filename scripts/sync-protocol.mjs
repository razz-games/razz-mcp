#!/usr/bin/env node
// Regenerate protocol.ts from @razz/shared opcodes and types.
// Run this when opcodes change in packages/shared/src/opcodes.ts.
//
// Usage: node scripts/sync-protocol.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SHARED_DIR = resolve(ROOT, "../shared/src");
const PROTOCOL_FILE = resolve(ROOT, "src/protocol.ts");

const opcodesSource = readFileSync(resolve(SHARED_DIR, "opcodes.ts"), "utf8");
const typesSource = readFileSync(resolve(SHARED_DIR, "types.ts"), "utf8");

// Extract the types actually used by the MCP server
const NEEDED_TYPES = [
  "RoomType", "Room", "RoomWithAccess", "Token", "TokenWithRooms",
  "ReactionSummary", "Message", "DirectMessage",
];

// Extract type/interface definitions from types.ts
function extractTypes(source, typeNames) {
  const chunks = [];
  for (const name of typeNames) {
    // Match: export type Name = ... or export interface Name { ... }
    const typeMatch = source.match(new RegExp(`export type ${name}\\s*=[^;]+;`));
    if (typeMatch) {
      chunks.push(typeMatch[0]);
      continue;
    }

    // Match interface (possibly extending) with its full body
    const ifaceRegex = new RegExp(
      `export interface ${name}(?:\\s+extends\\s+[\\w,\\s]+)?\\s*\\{`,
    );
    const match = ifaceRegex.exec(source);
    if (match) {
      let depth = 0;
      let end = match.index;
      for (let i = match.index; i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      chunks.push(source.slice(match.index, end));
    }
  }
  return chunks.join("\n\n");
}

const typeDefs = extractTypes(typesSource, NEEDED_TYPES);

const output = `// Razz protocol opcodes and types for the MCP server.
// Sourced from @razz/shared - regenerate with: npm run sync-protocol
// This file makes the MCP server self-contained (no monorepo dependency).
// AUTO-GENERATED - do not edit manually.

${opcodesSource}

// Types used by the MCP server (compile-time only)

${typeDefs}
`;

writeFileSync(PROTOCOL_FILE, output);
console.log(`Regenerated ${PROTOCOL_FILE}`);
console.log(`  Opcodes: synced from ${resolve(SHARED_DIR, "opcodes.ts")}`);
console.log(`  Types: ${NEEDED_TYPES.join(", ")}`);
