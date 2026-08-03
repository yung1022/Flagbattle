/**
 * Season sheet + points from stream ranking history.
 * Qualifying + Final livestreams are paired into one battle column.
 * Points: 1st→50, 2nd→49, … 50th→1 (ranks beyond 50 score 0).
 * Finished battles: place or "nq" (never "Q").
 */

import { previousPointsRanks, rankDelta } from "./rank-delta.js";

export const POINTS_TOP_N = 50;

export function pointsForRank(rank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1 || r > POINTS_TOP_N) return 0;
  return POINTS_TOP_N + 1 - r;
}

function isFinalStream(s) {
  if (!s) return false;
  if (s.mode === "final") return true;
  if (Array.isArray(s.final?.ranking) && s.final.ranking.length) return true;
  return false;
}

function isQualifyingStream(s) {
  if (!s || isFinalStream(s)) return false;
  if (s.mode === "qualifying") return true;
  // Legacy / unfinished: has qualifiers or rounds but no Final ranking yet.
  return (
    Array.isArray(s.qualified) ||
    Array.isArray(s.rounds) ||
    Boolean(s.endedAt)
  );
}

/**
 * Pair a finished qualifying stream with the following Final into one battle.
 * Old combined streams (qual + final on one record) stay a single column.
 * @returns {Array<{
 *   id: string,
 *   qualifying: object|null,
 *   final: object|null,
 *   startedAt: string|null,
 *   ended: boolean,
 *   winner: object|null,
 * }>}
 */
export function pairBattles(streams) {
  const sorted = [...(streams || [])].sort((a, b) =>
    (a.startedAt || "").localeCompare(b.startedAt || "")
  );
  const battles = [];
  let i = 0;
  while (i < sorted.length) {
    const s = sorted[i];

    // Single record that already includes a Final ranking (legacy combined).
    if (isFinalStream(s) && Array.isArray(s.qualified) && s.mode !== "final") {
      battles.push(makeBattle({ qualifying: s, final: s }));
      i += 1;
      continue;
    }

    if (isQualifyingStream(s)) {
      const next = sorted[i + 1];
      if (next && isFinalStream(next) && next.mode === "final") {
        battles.push(makeBattle({ qualifying: s, final: next }));
        i += 2;
        continue;
      }
      // Qualifying followed by a Final that carries ranking but no mode tag.
      if (
        next &&
        isFinalStream(next) &&
        !isQualifyingStream(next) &&
        next.id !== s.id
      ) {
        battles.push(makeBattle({ qualifying: s, final: next }));
        i += 2;
        continue;
      }
      battles.push(makeBattle({ qualifying: s, final: null }));
      i += 1;
      continue;
    }

    if (isFinalStream(s)) {
      battles.push(makeBattle({ qualifying: null, final: s }));
      i += 1;
      continue;
    }

    battles.push(makeBattle({ qualifying: s, final: null }));
    i += 1;
  }
  return battles;
}

function makeBattle({ qualifying, final }) {
  const primary = final || qualifying;
  const ended = Boolean(
    final?.endedAt ||
      (final?.final?.ranking && final.final.ranking.length) ||
      (qualifying &&
        final &&
        qualifying.id === final.id &&
        final?.final?.ranking?.length)
  );
  const ids = [...new Set([qualifying?.id, final?.id].filter(Boolean))];
  return {
    id: ids.join("+") || primary?.id || "battle",
    qualifying: qualifying || null,
    final: final || null,
    startedAt: qualifying?.startedAt || final?.startedAt || null,
    ended,
    winner: final?.winner || final?.final?.winner || null,
  };
}

/** Stable short label for a battle column. */
export function battleLabel(battle, index, total) {
  const when = battle.startedAt ? new Date(battle.startedAt) : null;
  const tag = battle.ended
    ? ""
    : battle.final
      ? ""
      : battle.qualifying
        ? " · qual"
        : "";
  if (when && !Number.isNaN(when.getTime())) {
    const md = when.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const hm = when.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${md} ${hm}${tag}`;
  }
  return `B${total - index}${tag}`;
}

/**
 * @deprecated Prefer battleResultForBattle — kept for callers with a raw stream.
 * @returns {number | "nq" | "Q" | "—"}
 */
export function battleResult(stream, code) {
  if (!stream) return "—";
  const battle = isFinalStream(stream)
    ? makeBattle({
        qualifying: Array.isArray(stream.qualified) ? stream : null,
        final: stream,
      })
    : makeBattle({ qualifying: stream, final: null });
  return battleResultForBattle(battle, code);
}

/**
 * Placement for a country in one (possibly merged) battle.
 * Finished battles never return "Q" — only place numbers or "nq".
 * @returns {number | "nq" | "Q" | "—"}
 */
export function battleResultForBattle(battle, code) {
  const final = battle?.final;
  const qualifying = battle?.qualifying;
  const ranking = final?.final?.ranking;

  // Finished Final (or legacy combined) → place or nq only.
  if (Array.isArray(ranking) && ranking.length) {
    const row = ranking.find((r) => r.code === code);
    if (row?.rank != null) return Number(row.rank);
    return "nq";
  }

  // Final stream ended with a winner but no full ranking (recovered).
  if (battle?.ended && (final?.winner || final?.final?.winner)) {
    const w = final.winner || final.final.winner;
    if (w?.code === code) return 1;
    return "nq";
  }

  // Qualifying only — battle not finished yet. Q/nq while waiting for Final.
  const qualList = qualifying?.qualified || final?.qualified || [];
  if (Array.isArray(qualList) && qualList.length) {
    if (qualList.some((q) => q.code === code)) return "Q";
    if (qualifying?.endedAt || final?.endedAt) return "nq";
    if ((qualifying?.rounds || []).length) return "—";
    return "—";
  }

  if ((qualifying?.rounds || final?.rounds || []).length) return "—";
  return "—";
}

/**
 * @param {Array} streams newest-first or any order
 * @param {Array<{code:string,name:string}>} countries
 */
export function buildSeasonSheet(streams, countries) {
  const battles = pairBattles(streams);

  const rows = countries.map((c) => {
    const results = battles.map((b) => battleResultForBattle(b, c.code));
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
    battles: battles.map((b, i) => ({
      id: b.id,
      label: battleLabel(b, i, battles.length),
      startedAt: b.startedAt || null,
      mode: b.ended ? "final" : b.final ? "final" : "qualifying",
      winner: b.winner?.name || null,
      hasFinal: Boolean(b.final?.final?.ranking?.length || b.ended),
      ended: b.ended,
      qualifiedCount: Array.isArray(b.qualifying?.qualified)
        ? b.qualifying.qualified.length
        : Array.isArray(b.final?.qualified)
          ? b.final.qualified.length
          : 0,
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
