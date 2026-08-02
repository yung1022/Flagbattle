/**
 * Season sheet + points from stream ranking history.
 * Points: 1st→50, 2nd→49, … 50th→1 (ranks beyond 50 score 0).
 * Non-finalists show as "nq".
 */

import { previousPointsRanks, rankDelta } from "./rank-delta.js";

export const POINTS_TOP_N = 50;

export function pointsForRank(rank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1 || r > POINTS_TOP_N) return 0;
  return POINTS_TOP_N + 1 - r;
}

/** Stable short label for a battle column. */
export function battleLabel(stream, index, total) {
  const when = stream.startedAt ? new Date(stream.startedAt) : null;
  const modeTag =
    stream?.mode === "final" ? " F" : stream?.mode === "qualifying" ? " Q" : "";
  if (when && !Number.isNaN(when.getTime())) {
    const md = when.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const hm = when.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${md} ${hm}${modeTag}`;
  }
  return `B${total - index}${modeTag}`;
}

/**
 * Placement / qualification for a country in one stream.
 * Qualifying streams: "Q" or "nq". Final streams: rank number or "nq".
 * @returns {number | "nq" | "Q" | "—"}
 */
export function battleResult(stream, code) {
  const mode = stream?.mode || (stream?.final?.ranking?.length ? "final" : null);

  if (mode === "qualifying" || (!mode && !stream?.final?.ranking?.length)) {
    const qualified = stream?.qualified || [];
    if (qualified.some((q) => q.code === code)) return "Q";
    if (stream?.endedAt) return "nq";
    if ((stream?.rounds || []).length) return "—";
    return "—";
  }

  const ranking = stream?.final?.ranking;
  if (Array.isArray(ranking) && ranking.length) {
    const row = ranking.find((r) => r.code === code);
    return row?.rank != null ? Number(row.rank) : "nq";
  }

  const qualified = stream?.qualified || [];
  if (qualified.some((q) => q.code === code)) return "Q";
  if (stream?.endedAt || stream?.winner) return "nq";
  if ((stream?.rounds || []).length) return "—";
  return "—";
}

/**
 * @param {Array} streams newest-first or any order
 * @param {Array<{code:string,name:string}>} countries
 */
export function buildSeasonSheet(streams, countries) {
  const battles = [...(streams || [])].sort((a, b) =>
    (a.startedAt || "").localeCompare(b.startedAt || "")
  );

  const rows = countries.map((c) => {
    const results = battles.map((s) => battleResult(s, c.code));
    /** Delta vs previous battle column (places gained). */
    const deltas = results.map((curr, i) => {
      if (i === 0) return null;
      return rankDelta(results[i - 1], curr);
    });
    let points = 0;
    let finishes = 0;
    let best = null;
    for (const r of results) {
      if (typeof r === "number") {
        finishes += 1;
        points += pointsForRank(r);
        if (best == null || r < best) best = r;
      }
    }
    return {
      code: c.code,
      name: c.name,
      img: `https://flagcdn.com/w40/${c.code}.png`,
      results,
      deltas,
      points,
      finishes,
      best,
    };
  });

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if ((a.best ?? 999) !== (b.best ?? 999)) return (a.best ?? 999) - (b.best ?? 999);
    return a.name.localeCompare(b.name);
  });

  return {
    battles: battles.map((s, i) => ({
      id: s.id,
      label: battleLabel(s, i, battles.length),
      startedAt: s.startedAt || null,
      mode: s.mode || (s.final?.ranking?.length ? "final" : "qualifying"),
      winner: s.winner?.name || s.final?.winner?.name || null,
      hasFinal: Boolean(s.final?.ranking?.length),
      qualifiedCount: Array.isArray(s.qualified) ? s.qualified.length : 0,
    })),
    rows,
  };
}

/** Standalone points leaderboard (same ordering as sheet). */
export function buildPointsLeaderboard(streams, countries) {
  const { rows } = buildSeasonSheet(streams, countries);
  const ranked = rows.map((r, i) => ({
    rank: i + 1,
    code: r.code,
    name: r.name,
    img: r.img,
    points: r.points,
    finishes: r.finishes,
    best: r.best,
  }));

  const prevRanks = previousPointsRanks(
    streams,
    countries,
    (s, c) => buildPointsLeaderboardBare(s, c)
  );
  for (const row of ranked) {
    const prev = prevRanks.get(row.code);
    row.delta = prev != null ? rankDelta(prev, row.rank) : null;
  }
  return ranked;
}

/** Leaderboard without recursive delta (used for “previous season” snapshot). */
function buildPointsLeaderboardBare(streams, countries) {
  const { rows } = buildSeasonSheet(streams, countries);
  return rows.map((r, i) => ({
    rank: i + 1,
    code: r.code,
    name: r.name,
    img: r.img,
    points: r.points,
    finishes: r.finishes,
    best: r.best,
  }));
}
