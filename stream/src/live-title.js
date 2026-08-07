/**
 * YouTube livestream titles:
 *   FLAG BATTLE - DD/MM/YYYY #N
 * where N is the stream index for that calendar day (resets daily).
 *
 * Variations keep the same date + #N core.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const TITLE_VARIATIONS = [
  (date, n) => `FLAG BATTLE - ${date} #${n}`,
  (date, n) => `FLAG BATTLE · ${date} #${n} · Last Flag Standing`,
  (date, n) => `FLAG BATTLE Live · ${date} #${n}`,
  (date, n) => `FLAG BATTLE #${n} · ${date} · Qualifying → Final`,
  (date, n) => `FLAG BATTLE - ${date} #${n} · Vote in Chat`,
  (date, n) => `FLAG BATTLE · Day ${date} · Stream #${n}`,
  (date, n) => `FLAG BATTLE #${n} - ${date} · Hole → Swiss → Final 4`,
];

/**
 * @param {Date} [now]
 * @param {{ timeZone?: string }} [opts]
 * @returns {{ dateKey: string, dateLabel: string, timeZone: string }}
 */
export function streamDayParts(now = new Date(), opts = {}) {
  const timeZone =
    opts.timeZone ||
    process.env.STREAM_TITLE_TZ ||
    process.env.TZ ||
    "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const dd = get("day");
  const mm = get("month");
  const yyyy = get("year");
  return {
    dateKey: `${yyyy}-${mm}-${dd}`,
    dateLabel: `${dd}/${mm}/${yyyy}`,
    timeZone,
  };
}

function readJsonArray(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.streams)) return raw.streams;
  } catch {
    /* missing / invalid */
  }
  return [];
}

/**
 * Count finished/recorded streams that started on the given calendar day.
 * @param {string} dateKey YYYY-MM-DD
 * @param {{ timeZone?: string, root?: string }} [opts]
 */
export function countStreamsOnDay(dateKey, opts = {}) {
  const root = opts.root || ROOT;
  const timeZone = opts.timeZone || process.env.STREAM_TITLE_TZ || process.env.TZ || "UTC";
  const streams = [
    ...readJsonArray(path.join(root, "data/rankings.json")),
    ...readJsonArray(path.join(root, "data/live.json")),
  ];
  const seen = new Set();
  let count = 0;
  for (const s of streams) {
    const id = s?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (s?.testStream || String(id).startsWith("test_")) continue;
    const started = s?.startedAt;
    if (!started) continue;
    const day = streamDayParts(new Date(started), { timeZone }).dateKey;
    if (day === dateKey) count += 1;
  }
  return count;
}

/**
 * Pick a title variation. Index rotates by daily stream number.
 * @param {number} streamNumber 1-based
 * @param {string} dateLabel DD/MM/YYYY
 * @param {number} [variationIndex]
 */
export function formatLiveTitle(streamNumber, dateLabel, variationIndex) {
  const n = Math.max(1, Number(streamNumber) || 1);
  const date = String(dateLabel || "??/??/????");
  const idx =
    variationIndex != null
      ? Number(variationIndex)
      : (n - 1) % TITLE_VARIATIONS.length;
  const i = ((idx % TITLE_VARIATIONS.length) + TITLE_VARIATIONS.length) % TITLE_VARIATIONS.length;
  const title = TITLE_VARIATIONS[i](date, n);
  return String(title).slice(0, 100);
}

/**
 * Build the next go-live title from history.
 * @param {{ now?: Date, timeZone?: string, root?: string, variationIndex?: number }} [opts]
 * @returns {{ title: string, dateLabel: string, dateKey: string, streamNumber: number, variationIndex: number }}
 */
export function buildNextLiveTitle(opts = {}) {
  const now = opts.now || new Date();
  const { dateKey, dateLabel, timeZone } = streamDayParts(now, {
    timeZone: opts.timeZone,
  });
  const prior = countStreamsOnDay(dateKey, {
    timeZone,
    root: opts.root,
  });
  const streamNumber = prior + 1;
  const variationIndex =
    opts.variationIndex != null
      ? Number(opts.variationIndex)
      : (streamNumber - 1) % TITLE_VARIATIONS.length;
  const title = formatLiveTitle(streamNumber, dateLabel, variationIndex);
  return {
    title,
    dateLabel,
    dateKey,
    streamNumber,
    variationIndex,
    timeZone,
  };
}

export { TITLE_VARIATIONS };
