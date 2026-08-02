/**
 * Decide the next livestream mode from ranking history.
 * After a finished qualifying run with qualifiers → final.
 * Otherwise → qualifying.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveNextMode(streams) {
  const list = Array.isArray(streams) ? [...streams] : [];
  list.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));

  const last = list.find((s) => s?.endedAt) || list[0] || null;
  if (!last) return "qualifying";

  const mode =
    last.mode ||
    (last.final?.ranking?.length
      ? "final"
      : last.endedAt && Array.isArray(last.qualified) && last.qualified.length
        ? "qualifying"
        : null);

  if (
    mode === "qualifying" &&
    Array.isArray(last.qualified) &&
    last.qualified.length
  ) {
    return "final";
  }
  return "qualifying";
}

function main() {
  const file = process.argv[2] || "data/rankings.json";
  let streams = [];
  try {
    streams = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    streams = [];
  }
  process.stdout.write(resolveNextMode(streams));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
