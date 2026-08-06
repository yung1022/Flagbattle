/**
 * Resolve the next livestream mode.
 * Qualifying + Final run as one continuous "full battle" stream, so go-live
 * always starts in qualifying (Final continues in the same broadcast).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @deprecated Kept for callers; always returns qualifying (unified stream). */
export function resolveNextMode(_streams) {
  return "qualifying";
}

function main() {
  // Accept optional rankings path for backward compatibility with go-live.yml.
  void (process.argv[2] || "data/rankings.json");
  process.stdout.write("qualifying");
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
