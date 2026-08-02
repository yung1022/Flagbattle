/**
 * Position gained/lost helpers for season points + battle sheet.
 * Positive delta = moved up (better rank number is smaller).
 */

/** @returns {number|null} places gained (prevRank - currRank), or null if N/A */
export function rankDelta(prev, curr) {
  if (typeof prev !== "number" || typeof curr !== "number") return null;
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  return prev - curr;
}

export function formatDelta(delta) {
  if (delta == null || delta === 0) return { text: "—", cls: "delta-flat", arrow: "→" };
  if (delta > 0) return { text: String(delta), cls: "delta-up", arrow: "↑" };
  return { text: String(Math.abs(delta)), cls: "delta-down", arrow: "↓" };
}

/**
 * Season points rank before the latest finished Final (for arrows on points list).
 * @param {Array} streams
 * @param {Array} countries
 * @param {(streams:any[], countries:any[]) => any[]} buildLeaderboard
 */
export function previousPointsRanks(streams, countries, buildLeaderboard) {
  const finished = [...(streams || [])]
    .filter((s) => s.final?.ranking?.length)
    .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  if (finished.length < 2) return new Map();

  const prior = finished.slice(0, -1);
  // Keep unfinished streams out — points only come from finals.
  const board = buildLeaderboard(prior, countries);
  return new Map(board.map((r) => [r.code, r.rank]));
}
