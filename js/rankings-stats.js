/**
 * Season sheet + points from stream ranking history.
 * Qualifying + Final livestreams are paired into one battle column.
 * Points: 1st→50, 2nd→49, … 50th→1 (Final places only; ranks beyond 50 score 0).
 * Poll bonus when Final ends: 1st→10, 2nd→5, 3rd→3, 4th→2, 5th→1.
 * Finished battles: Final place, or non-qualifier place from average qualifying-round rank.
 * "Q" only while waiting for that battle’s Final.
 */

import { previousPointsRanks, rankDelta } from "./rank-delta.js";

export const POINTS_TOP_N = 50;
/** Extra season points from Final poll places 1–5. */
export const POLL_PLACE_POINTS = [10, 5, 3, 2, 1];

export function pointsForRank(rank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1 || r > POINTS_TOP_N) return 0;
  return POINTS_TOP_N + 1 - r;
}

export function pollPointsForPlace(rank) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1 || r > POLL_PLACE_POINTS.length) return 0;
  return POLL_PLACE_POINTS[r - 1];
}

/** Sum frozen poll bonus for a country from a battle’s Final record. */
export function pollBonusForBattle(battle, code) {
  const places =
    battle?.final?.final?.pollPlaces ||
    battle?.final?.pollPlaces ||
    null;
  if (!Array.isArray(places) || !code) return 0;
  const c = String(code).toLowerCase();
  const hit = places.find((p) => String(p?.code || "").toLowerCase() === c);
  if (!hit) return 0;
  if (Number.isFinite(Number(hit.points))) return Number(hit.points);
  return pollPointsForPlace(hit.rank);
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
 * Mean place across every qualifying round a country appeared in.
 * Lower is better (rank 1 = last standing that round).
 * @returns {number} average, or Infinity when no round data
 */
export function averageQualifyingRating(stream, code) {
  const rounds = stream?.rounds || [];
  let sum = 0;
  let count = 0;
  for (const round of rounds) {
    const row = (round.ranking || []).find((r) => r.code === code);
    if (row && Number.isFinite(Number(row.rank))) {
      sum += Number(row.rank);
      count += 1;
    }
  }
  if (!count) return Infinity;
  return sum / count;
}

/**
 * Non-qualifiers ordered by average qualifying-round place (best avg → first).
 * Places start after Finalists (or after qualifier count when Final is pending).
 * @returns {Map<string, number>}
 */
export function buildNonQualifierRanks(battle) {
  const stream =
    battle?.qualifying ||
    (Array.isArray(battle?.final?.rounds) && battle.final.rounds.length
      ? battle.final
      : null);
  const rounds = stream?.rounds || [];
  if (!rounds.length) return new Map();

  const excluded = new Set();
  for (const q of battle?.qualifying?.qualified || battle?.final?.qualified || []) {
    if (q?.code) excluded.add(q.code);
  }
  const finalRanking = battle?.final?.final?.ranking || [];
  for (const row of finalRanking) {
    if (row?.code) excluded.add(row.code);
  }

  const sums = new Map();
  for (const round of rounds) {
    for (const row of round.ranking || []) {
      if (!row?.code || excluded.has(row.code)) continue;
      const rank = Number(row.rank);
      if (!Number.isFinite(rank)) continue;
      const cur = sums.get(row.code) || { sum: 0, count: 0 };
      cur.sum += rank;
      cur.count += 1;
      sums.set(row.code, cur);
    }
  }

  const ordered = [...sums.entries()]
    .map(([code, { sum, count }]) => [code, sum / count])
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  let startPlace = excluded.size + 1;
  if (finalRanking.length) {
    let maxRank = 0;
    for (const row of finalRanking) {
      const r = Number(row.rank);
      if (Number.isFinite(r) && r > maxRank) maxRank = r;
    }
    startPlace = maxRank + 1;
  }

  const map = new Map();
  ordered.forEach(([code], i) => map.set(code, startPlace + i));
  return map;
}

const _nqRankCache = new WeakMap();

function nonQualifierRanksFor(battle) {
  if (!battle) return new Map();
  let map = _nqRankCache.get(battle);
  if (!map) {
    map = buildNonQualifierRanks(battle);
    _nqRankCache.set(battle, map);
  }
  return map;
}

/** True when this country has a scored Final place in the battle. */
export function isFinalistInBattle(battle, code) {
  const ranking = battle?.final?.final?.ranking;
  if (!Array.isArray(ranking) || !ranking.length) return false;
  return ranking.some((r) => r.code === code);
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
 * Finished battles never return "Q" — Final place, or avg qualifying place for nq.
 * @returns {number | "nq" | "Q" | "—"}
 */
export function battleResultForBattle(battle, code) {
  const final = battle?.final;
  const qualifying = battle?.qualifying;
  const ranking = final?.final?.ranking;

  // Finished Final (or legacy combined) → Final place, else avg qualifying rank.
  if (Array.isArray(ranking) && ranking.length) {
    const row = ranking.find((r) => r.code === code);
    if (row?.rank != null) return Number(row.rank);
    const nqRank = nonQualifierRanksFor(battle).get(code);
    if (nqRank != null) return nqRank;
    return "nq";
  }

  // Final stream ended with a winner but no full ranking (recovered).
  if (battle?.ended && (final?.winner || final?.final?.winner)) {
    const w = final.winner || final.final.winner;
    if (w?.code === code) return 1;
    const nqRank = nonQualifierRanksFor(battle).get(code);
    if (nqRank != null) return nqRank;
    return "nq";
  }

  // Qualifying only — battle not finished yet. Q for qualifiers; nq by avg rating.
  const qualList = qualifying?.qualified || final?.qualified || [];
  if (Array.isArray(qualList) && qualList.length) {
    if (qualList.some((q) => q.code === code)) return "Q";
    if (qualifying?.endedAt || final?.endedAt || (qualifying?.rounds || []).length) {
      const nqRank = nonQualifierRanksFor(battle).get(code);
      if (nqRank != null) return nqRank;
      return "nq";
    }
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
    let pollBonus = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      // Points / best finish only from Final places — not avg nq ranks.
      if (typeof r === "number" && isFinalistInBattle(battles[i], c.code)) {
        finishes += 1;
        points += pointsForRank(r);
        if (best == null || r < best) best = r;
      }
      pollBonus += pollBonusForBattle(battles[i], c.code);
    }
    points += pollBonus;
    return {
      code: c.code,
      name: c.name,
      img: `https://flagcdn.com/w40/${c.code}.png`,
      results,
      deltas,
      points,
      pollBonus,
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
