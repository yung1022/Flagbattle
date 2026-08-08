/**
 * Season sheet + points from stream ranking history.
 * Qualifying + Final livestreams are paired into one battle column.
 *
 * Scoring (wins_v1):
 *   +1 point per whole-game win (Last Flag Standing / battle.winner).
 *   Tiebreak: earlier first-win timestamp ranks higher.
 * Opening (sprint) round wins are unscored.
 *
 * Battle sheet still shows Final place / Q / nq for history.
 */

import { previousPointsRanks, rankDelta } from "./rank-delta.js";

export const POINTS_TOP_N = 50;
/** @deprecated Poll bonus no longer adds season points (wins_v1). Kept for display helpers. */
export const POLL_PLACE_POINTS = [10, 5, 3, 2, 1];

/** @deprecated Place-based season points removed — use +1 per win. */
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
  const c = String(code || "").toLowerCase();
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

/** Unified Qual→Final livestream (rounds + Final ranking on one record). */
function isUnifiedBattleStream(s) {
  if (!s || !isFinalStream(s)) return false;
  if (!Array.isArray(s.qualified) || !s.qualified.length) return false;
  return Array.isArray(s.rounds) && s.rounds.length > 0;
}

/**
 * Finalist-only Final ranking for sheet/points.
 * Strips polluted rows (e.g. merged-stream Qual fallouts that made ranking = 194).
 */
export function normalizeFinalistRanking(battleOrFinal, qualifiedList) {
  const final =
    battleOrFinal?.final?.final != null
      ? battleOrFinal.final
      : battleOrFinal?.final != null && battleOrFinal.final.ranking
        ? battleOrFinal
        : battleOrFinal;
  const ranking = Array.isArray(final?.final?.ranking)
    ? final.final.ranking
    : Array.isArray(final?.ranking)
      ? final.ranking
      : [];
  if (!ranking.length) return [];

  const qual =
    qualifiedList ||
    battleOrFinal?.final?.qualified ||
    battleOrFinal?.qualifying?.qualified ||
    final?.qualified ||
    [];
  const qualSet = new Set(
    (Array.isArray(qual) ? qual : [])
      .map((q) => String(q?.code || "").toLowerCase())
      .filter(Boolean)
  );
  if (!qualSet.size) {
    return ranking.map((r, i) => ({
      ...r,
      rank: Number(r.rank) || i + 1,
    }));
  }

  const filtered = ranking.filter((r) =>
    qualSet.has(String(r?.code || "").toLowerCase())
  );
  // Polluted ranking: keep finalist relative order, renumber 1..N.
  if (filtered.length && filtered.length < ranking.length) {
    return filtered.map((r, i) => ({
      code: r.code,
      name: r.name,
      img: r.img,
      rank: i + 1,
    }));
  }
  return filtered.map((r, i) => ({
    ...r,
    rank: Number(r.rank) || i + 1,
  }));
}

/** Chronological key: live start, else schedule time. */
function streamTimeKey(s) {
  return s?.startedAt || s?.scheduledAt || "";
}

/** Final-only companion (separate stream, not a unified Qual→Final). */
function isFinalOnlyCompanion(s) {
  if (!s || !isFinalStream(s)) return false;
  if (isUnifiedBattleStream(s)) return false;
  // Companion Finals have no Qualifying rounds of their own.
  return !(Array.isArray(s.rounds) && s.rounds.length > 0);
}

function qualifiedCodes(s) {
  return new Set(
    (s?.qualified || [])
      .map((q) => String(q?.code || "").toLowerCase())
      .filter(Boolean)
  );
}

function qualifiedOverlapRatio(a, b) {
  const A = qualifiedCodes(a);
  const B = qualifiedCodes(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const c of A) if (B.has(c)) hit += 1;
  return hit / Math.max(A.size, B.size);
}

/**
 * Pair a finished qualifying stream with the following Final into one battle.
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
    streamTimeKey(a).localeCompare(streamTimeKey(b))
  );
  const used = new Set();
  const battles = [];

  const take = (s) => {
    if (!s?.id || used.has(s.id)) return false;
    used.add(s.id);
    return true;
  };

  // 1) Unified / legacy combined records are complete battles on their own.
  for (const s of sorted) {
    if (used.has(s.id)) continue;
    if (isUnifiedBattleStream(s)) {
      take(s);
      battles.push(makeBattle({ qualifying: s, final: s }));
      continue;
    }
    // Legacy combined without mode:"final" (ranking + qualified, may lack rounds).
    if (
      isFinalStream(s) &&
      Array.isArray(s.qualified) &&
      s.qualified.length &&
      s.mode !== "final" &&
      Array.isArray(s.final?.ranking) &&
      s.final.ranking.length
    ) {
      take(s);
      battles.push(makeBattle({ qualifying: s, final: s }));
    }
  }

  // 2) Pair remaining Qualifying with a Final-only companion (not unified).
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (used.has(s.id) || !isQualifyingStream(s)) continue;

    let final = null;
    // Prefer the next chronological Final-only companion.
    for (let j = i + 1; j < sorted.length; j++) {
      const n = sorted[j];
      if (used.has(n.id)) continue;
      if (!isFinalOnlyCompanion(n)) continue;
      final = n;
      break;
    }
    // Scheduled Finals may sort before their Qual (startedAt null) — match by roster.
    if (!final) {
      let best = null;
      let bestScore = 0;
      for (const n of sorted) {
        if (used.has(n.id) || n.id === s.id) continue;
        if (!isFinalOnlyCompanion(n)) continue;
        const score = qualifiedOverlapRatio(s, n);
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      if (best && bestScore >= 0.9) final = best;
    }

    take(s);
    if (final) take(final);
    battles.push(makeBattle({ qualifying: s, final }));
  }

  // 3) Any leftover Final / other records.
  for (const s of sorted) {
    if (used.has(s.id)) continue;
    take(s);
    if (isFinalStream(s)) {
      battles.push(makeBattle({ qualifying: null, final: s }));
    } else {
      battles.push(makeBattle({ qualifying: s, final: null }));
    }
  }

  battles.sort((a, b) =>
    (a.startedAt || a.final?.scheduledAt || "").localeCompare(
      b.startedAt || b.final?.scheduledAt || ""
    )
  );
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

/** ISO timestamp when a battle awarded its whole-game win point. */
export function battleWinAt(battle) {
  if (!battle?.ended) return null;
  const w = battle.winner || battle.final?.winner || battle.final?.final?.winner;
  if (!w?.code) return null;
  return (
    battle.final?.final?.at ||
    battle.final?.final?.pointAt ||
    battle.final?.endedAt ||
    battle.startedAt ||
    null
  );
}

/** True when this country won the whole game for the battle (+1 point). */
export function isBattleWinner(battle, code) {
  if (!battle?.ended || !code) return false;
  const w = battle.winner || battle.final?.winner || battle.final?.final?.winner;
  return String(w?.code || "").toLowerCase() === String(code).toLowerCase();
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
  // Finalists only (normalize strips polluted Qual fallouts from merged streams).
  const finalRanking = normalizeFinalistRanking(battle);
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
  const ranking = normalizeFinalistRanking(battle);
  if (!ranking.length) return false;
  const c = String(code || "").toLowerCase();
  return ranking.some((r) => String(r.code || "").toLowerCase() === c);
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
  const ranking = normalizeFinalistRanking(battle);

  // Finished Final (or legacy combined) → Final place, else avg qualifying rank.
  if (Array.isArray(ranking) && ranking.length) {
    const c = String(code || "").toLowerCase();
    const row = ranking.find((r) => String(r.code || "").toLowerCase() === c);
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
    let firstWinAt = null;
    let pollBonus = 0;
    for (let i = 0; i < battles.length; i++) {
      const b = battles[i];
      // Whole-game win → +1 season point.
      if (isBattleWinner(b, c.code)) {
        points += 1;
        finishes += 1;
        const at = battleWinAt(b);
        if (at && (firstWinAt == null || at < firstWinAt)) firstWinAt = at;
      }
      // Track best Final place for sheet meta (not used for points/sort).
      const r = results[i];
      if (typeof r === "number" && isFinalistInBattle(b, c.code)) {
        if (best == null || r < best) best = r;
      }
      pollBonus += pollBonusForBattle(b, c.code);
    }
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
      firstWinAt,
    };
  });

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    // Same wins: earlier first point → better position.
    if (a.firstWinAt && b.firstWinAt && a.firstWinAt !== b.firstWinAt) {
      return a.firstWinAt.localeCompare(b.firstWinAt);
    }
    if (a.firstWinAt && !b.firstWinAt) return -1;
    if (!a.firstWinAt && b.firstWinAt) return 1;
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
    firstWinAt: r.firstWinAt || null,
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
    firstWinAt: r.firstWinAt || null,
  }));
}

/**
 * Live Main-points rank change after awarding +1 last-standing point.
 * @param {Map<string, number>|Record<string, number>} beforePoints
 * @param {Map<string, number>|Record<string, number>} beforeFirstAt ms timestamps
 * @param {Map<string, number>|Record<string, number>} afterPoints
 * @param {Map<string, number>|Record<string, number>} afterFirstAt
 * @param {{code:string,name:string,img?:string}} scorer
 * @param {Array<{code:string,name:string}>} [countries]
 */
export function computeMainPointRankReveal(
  beforePoints,
  beforeFirstAt,
  afterPoints,
  afterFirstAt,
  scorer,
  countries = []
) {
  const code = String(scorer?.code || "").toLowerCase();
  const nameOf = (c) => {
    const hit = (countries || []).find(
      (x) => String(x.code || "").toLowerCase() === c
    );
    return hit?.name || c.toUpperCase();
  };
  const toMap = (src) => {
    if (!src) return new Map();
    if (src instanceof Map) return src;
    return new Map(
      Object.entries(src).map(([k, v]) => [String(k).toLowerCase(), v])
    );
  };
  const board = (pointsSrc, firstSrc) => {
    const points = toMap(pointsSrc);
    const firstAt = toMap(firstSrc);
    const rows = [];
    for (const [c, p] of points) {
      const n = Number(p) || 0;
      if (n <= 0) continue;
      rows.push({
        code: c,
        name: nameOf(c),
        points: n,
        firstAt: Number(firstAt.get(c)) || 0,
      });
    }
    rows.sort(
      (a, b) =>
        b.points - a.points ||
        (a.firstAt || 0) - (b.firstAt || 0) ||
        a.name.localeCompare(b.name)
    );
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
  };

  const prevBoard = board(beforePoints, beforeFirstAt);
  const nextBoard = board(afterPoints, afterFirstAt);
  const prevRow = prevBoard.find((r) => r.code === code);
  const nextRow = nextBoard.find((r) => r.code === code);
  const prevPoints = Number(prevRow?.points) || 0;
  const points = Number(nextRow?.points) || prevPoints + 1;
  const fromRank = prevPoints > 0 ? (prevRow?.rank ?? null) : null;
  const toRank = nextRow?.rank ?? 1;
  const delta =
    fromRank != null && Number.isFinite(toRank) ? fromRank - toRank : null;

  return {
    kind: "main_point",
    code: scorer.code,
    name: scorer.name,
    img: scorer.img || `https://flagcdn.com/w160/${scorer.code}.png`,
    fromRank,
    toRank,
    points,
    prevPoints,
    delta,
    firstWin: prevPoints === 0,
  };
}

/**
 * Compute championship rank change for a country after awarding +1 win.
 * @param {Array} priorStreams streams BEFORE this win is recorded
 * @param {Array} countries
 * @param {{code:string,name:string,img?:string}} winner
 * @param {object|null} currentStream stream record that will hold this win
 * @returns {{code:string,name:string,img:string,fromRank:number|null,toRank:number,points:number,prevPoints:number,delta:number|null,firstWin:boolean}}
 */
export function computeWinRankReveal(
  priorStreams,
  countries,
  winner,
  currentStream = null
) {
  const code = String(winner?.code || "").toLowerCase();
  const prior = (priorStreams || []).filter(
    (s) => !currentStream?.id || s.id !== currentStream.id
  );
  const prevBoard = buildPointsLeaderboardBare(prior, countries);
  const prevRow = prevBoard.find((r) => r.code === code);
  const prevPoints = Number(prevRow?.points) || 0;
  // Unranked (0 wins) shows as NEW rather than a zero-point alphabetical place.
  const fromRank = prevPoints > 0 ? (prevRow?.rank ?? null) : null;

  const pointAt = new Date().toISOString();
  const hypothetical = {
    ...(currentStream || {}),
    id: currentStream?.id || `win-${code}-${pointAt}`,
    mode: "final",
    winner: {
      code: winner.code,
      name: winner.name,
      img: winner.img || `https://flagcdn.com/w160/${winner.code}.png`,
    },
    final: {
      ranking: [
        {
          code: winner.code,
          name: winner.name,
          img: winner.img || `https://flagcdn.com/w160/${winner.code}.png`,
          rank: 1,
        },
      ],
      winner: {
        code: winner.code,
        name: winner.name,
        img: winner.img || `https://flagcdn.com/w160/${winner.code}.png`,
      },
      at: pointAt,
      pointAt,
      scoring: "wins_v1",
    },
    endedAt: pointAt,
    startedAt: currentStream?.startedAt || pointAt,
  };

  const nextBoard = buildPointsLeaderboardBare([hypothetical, ...prior], countries);
  const nextRow = nextBoard.find((r) => r.code === code);
  const toRank = nextRow?.rank ?? 1;
  const points = Number(nextRow?.points) || prevPoints + 1;
  const delta =
    fromRank != null && Number.isFinite(toRank) ? fromRank - toRank : null;

  return {
    kind: "season_win",
    code: winner.code,
    name: winner.name,
    img: winner.img || `https://flagcdn.com/w160/${winner.code}.png`,
    fromRank,
    toRank,
    points,
    prevPoints,
    delta,
    firstWin: prevPoints === 0,
  };
}
