/**
 * Prediction slots + scoring rules + selecting-session windows.
 *
 * Selecting is OPEN only:
 *   - after a Final has ended, until the next Qualifying starts, or
 *   - before Qualifying starts (including pre-qual intermission).
 * Closed during Qualifying / Final.
 *
 * Slot 1→100 … Slot 5→10 if that country wins; +5 per pick that qualifies.
 */

export const SLOT_POINTS = [100, 50, 25, 15, 10];
export const QUALIFY_BONUS = 5;
export const SLOT_COUNT = 5;
export const UPCOMING_BATTLE_ID = "upcoming";

export function emptySlots() {
  return Array.from({ length: SLOT_COUNT }, () => null);
}

/** Normalize to lowercase ISO codes; pad/trim to SLOT_COUNT. */
export function normalizeSlots(slots) {
  const out = emptySlots();
  const list = Array.isArray(slots) ? slots : [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const code = String(list[i] || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    out[i] = code || null;
  }
  return out;
}

export function slotsAreComplete(slots) {
  const n = normalizeSlots(slots);
  if (n.some((c) => !c)) return false;
  return new Set(n).size === SLOT_COUNT;
}

/**
 * @param {string[]} slots length 5 country codes
 * @param {{ winnerCode?: string|null, qualifiedCodes?: string[] }} result
 */
export function scorePrediction(slots, result = {}) {
  const codes = normalizeSlots(slots);
  const winner = String(result.winnerCode || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const qualSet = new Set(
    (result.qualifiedCodes || [])
      .map((c) =>
        String(c || "")
          .toLowerCase()
          .replace(/[^a-z]/g, "")
      )
      .filter(Boolean)
  );

  let win = 0;
  let winSlot = null;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (winner && codes[i] === winner) {
      win += SLOT_POINTS[i];
      winSlot = i + 1;
      break;
    }
  }

  let qualify = 0;
  const qualifiedHits = [];
  for (const code of new Set(codes.filter(Boolean))) {
    if (qualSet.has(code)) {
      qualify += QUALIFY_BONUS;
      qualifiedHits.push(code);
    }
  }

  return {
    win,
    winSlot,
    qualify,
    qualifiedHits,
    total: win + qualify,
  };
}

function iso(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function battleFinished(battle) {
  return Boolean(
    battle?.ended ||
      battle?.final?.endedAt ||
      battle?.final?.final?.ranking?.length ||
      battle?.final?.final?.winner ||
      battle?.winner
  );
}

function finalEndedAtMs(battle) {
  return (
    parseTime(battle?.final?.endedAt) ||
    parseTime(battle?.final?.final?.at) ||
    parseTime(battle?.endedAt) ||
    parseTime(battle?.final?.startedAt) ||
    null
  );
}

function qualStartedAtMs(battle) {
  return parseTime(battle?.qualifying?.startedAt) || parseTime(battle?.startedAt);
}

/** Live pre-qual intermission = still before qualifying clock. */
export function isPreQualIntermission(liveSnap) {
  if (!liveSnap?.streamId) return false;
  if (liveSnap.phase !== "intermission") return false;
  if (liveSnap.mode === "final") return false;
  return true;
}

/** Battle in progress for prediction lock (qual clock or Final). */
export function isBattleLockedPhase(liveSnap) {
  if (!liveSnap?.streamId) return false;
  const phase = liveSnap.phase;
  if (!phase || phase === "finished" || phase === "idle") return false;
  if (isPreQualIntermission(liveSnap)) return false;
  return true;
}

function newestBattle(battles) {
  const list = [...(battles || [])].sort((a, b) =>
    (b.startedAt || "").localeCompare(a.startedAt || "")
  );
  return list[0] || null;
}

function newestFinishedBattle(battles) {
  const list = [...(battles || [])]
    .filter(battleFinished)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return list[0] || null;
}

function summarizeBattle(battle, status, { locked, battleId } = {}) {
  const qual = battle?.qualifying;
  const fin = battle?.final;
  const id =
    battleId ||
    qual?.id ||
    (battle?.id && String(battle.id).split("+")[0]) ||
    fin?.id ||
    battle?.id ||
    UPCOMING_BATTLE_ID;
  const qualified = qual?.qualified || fin?.qualified || [];
  const winner =
    battle?.winner || fin?.winner || fin?.final?.winner || null;
  return {
    battleId: id,
    status,
    label: battleLabel(battle) || (status === "upcoming" ? "Next battle" : id),
    startedAt: battle?.startedAt || qual?.startedAt || fin?.startedAt || null,
    qualifyingEnded: Boolean(qual?.endedAt),
    finalEnded: battleFinished(battle),
    locked: Boolean(locked),
    qualified: qualified.map((q) => ({
      code: q.code,
      name: q.name,
      img: q.img,
    })),
    winner: winner
      ? { code: winner.code, name: winner.name, img: winner.img }
      : null,
    battle: battle || null,
  };
}

function battleLabel(battle) {
  const when = battle?.startedAt ? new Date(battle.startedAt) : null;
  if (when && !Number.isNaN(when.getTime())) {
    return when.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return battle?.id || null;
}

/**
 * Current + next selecting sessions and whether the user may edit picks now.
 *
 * @returns {{
 *   canSelect: boolean,
 *   target: object,
 *   current: { open: boolean, startsAt: string|null, endsAt: string|null, label: string }|null,
 *   next: { startsAt: string|null, endsAt: string|null, label: string }|null,
 * }}
 */
export function resolvePredictionSession(battles, liveSnap = null, now = Date.now()) {
  const list = Array.isArray(battles) ? battles : [];
  const finished = newestFinishedBattle(list);
  const lastFinalEnd = finished ? finalEndedAtMs(finished) : null;

  // ——— Live pre-qual intermission: selecting still open (before qualifying) ———
  if (isPreQualIntermission(liveSnap)) {
    const endsAt =
      liveSnap.intermissionRemainingMs != null
        ? now + Number(liveSnap.intermissionRemainingMs)
        : null;
    const existing = list.find(
      (b) =>
        b.qualifying?.id === liveSnap.streamId ||
        b.id === liveSnap.streamId ||
        String(b.id || "").startsWith(liveSnap.streamId)
    );
    const target = existing
      ? summarizeBattle(existing, "pre-qual", {
          locked: false,
          battleId: liveSnap.streamId,
        })
      : {
          battleId: liveSnap.streamId,
          status: "pre-qual",
          label: "Next battle · pre-qual intermission",
          startedAt: liveSnap.startedAt || null,
          qualifyingEnded: false,
          finalEnded: false,
          locked: false,
          qualified: [],
          winner: null,
          battle: null,
        };

    return {
      canSelect: true,
      target,
      current: {
        open: true,
        startsAt: iso(lastFinalEnd) || iso(now),
        endsAt: iso(endsAt),
        label: "Before qualifying (intermission)",
      },
      next: {
        startsAt: iso(endsAt), // after this battle’s Final — unknown; show placeholder after lock
        endsAt: null,
        label: "After this Final ends → until the following qualifying",
      },
    };
  }

  // ——— Live battle locked (qualifying / Final) ———
  if (isBattleLockedPhase(liveSnap)) {
    const existing = list.find(
      (b) =>
        b.qualifying?.id === liveSnap.streamId ||
        b.final?.id === liveSnap.streamId ||
        b.id === liveSnap.streamId ||
        String(b.id || "").includes(liveSnap.streamId)
    );
    const target = existing
      ? summarizeBattle(existing, liveSnap.mode === "final" ? "final" : "qualifying", {
          locked: true,
          battleId:
            existing.qualifying?.id ||
            liveSnap.streamId ||
            existing.id,
        })
      : {
          battleId: liveSnap.streamId,
          status: liveSnap.mode === "final" ? "final" : "qualifying",
          label:
            liveSnap.mode === "final" ? "Final in progress" : "Qualifying in progress",
          startedAt: null,
          qualifyingEnded: liveSnap.mode === "final",
          finalEnded: false,
          locked: true,
          qualified: Array.isArray(liveSnap.qualified) ? liveSnap.qualified : [],
          winner: liveSnap.winner || null,
          battle: null,
        };

    // Current selecting session already closed when qual started.
    const qualStart =
      (existing && qualStartedAtMs(existing)) ||
      parseTime(liveSnap.startedAt) ||
      now;

    return {
      canSelect: false,
      target,
      current: {
        open: false,
        startsAt: iso(lastFinalEnd),
        endsAt: iso(qualStart),
        label: "Closed — battle in progress",
      },
      next: {
        startsAt: null, // when Final ends
        endsAt: null,
        label: "Opens when this Final ends · closes when next qualifying starts",
      },
    };
  }

  // ——— No live lock: open selecting after Final (or first-ever) ———
  const pendingFinal = list.find(
    (b) =>
      b.qualifying?.endedAt &&
      !battleFinished(b) &&
      !b.final?.endedAt
  );
  if (pendingFinal) {
    // Qual done, Final not finished — still locked for this battle.
    const target = summarizeBattle(pendingFinal, "pending-final", {
      locked: true,
    });
    return {
      canSelect: false,
      target,
      current: {
        open: false,
        startsAt: iso(lastFinalEnd),
        endsAt: iso(qualStartedAtMs(pendingFinal)),
        label: "Closed — waiting for Final",
      },
      next: {
        startsAt: null,
        endsAt: null,
        label: "Opens when Final ends · closes when next qualifying starts",
      },
    };
  }

  const openQual = list.find(
    (b) =>
      b.qualifying &&
      !b.qualifying.endedAt &&
      !battleFinished(b)
  );
  // History shows an unfinished qual but no live snap — treat as locked once started.
  if (openQual && (openQual.qualifying.rounds?.length || openQual.qualifying.startedAt)) {
    const target = summarizeBattle(openQual, "qualifying", { locked: true });
    return {
      canSelect: false,
      target,
      current: {
        open: false,
        startsAt: iso(lastFinalEnd),
        endsAt: iso(qualStartedAtMs(openQual)),
        label: "Closed — qualifying underway",
      },
      next: {
        startsAt: null,
        endsAt: null,
        label: "Opens when Final ends · closes when next qualifying starts",
      },
    };
  }

  // Selecting open for upcoming battle.
  const target = {
    battleId: UPCOMING_BATTLE_ID,
    status: "upcoming",
    label: finished ? "Next battle" : "Upcoming battle",
    startedAt: null,
    qualifyingEnded: false,
    finalEnded: false,
    locked: false,
    qualified: [],
    winner: null,
    battle: null,
    // Keep last finished for scoreboard context when reviewing prior picks.
    previousBattleId: finished
      ? finished.qualifying?.id || String(finished.id || "").split("+")[0]
      : null,
  };

  return {
    canSelect: true,
    target,
    current: {
      open: true,
      startsAt: iso(lastFinalEnd) || iso(now),
      endsAt: null,
      label: lastFinalEnd
        ? "After Final · until next qualifying starts"
        : "Open · until next qualifying starts",
    },
    next: {
      startsAt: null,
      endsAt: null,
      label: "After the next Final ends · until the following qualifying",
    },
  };
}

/**
 * @deprecated Prefer resolvePredictionSession — kept for older callers.
 */
export function predictionBattleTarget(battles, liveSnap = null) {
  return resolvePredictionSession(battles, liveSnap).target;
}

/** Resolve result fields for scoring from a target summary or raw battle. */
export function battleResultCodes(target) {
  if (!target) return { winnerCode: null, qualifiedCodes: [] };
  const qualifiedCodes = (target.qualified || []).map((q) => q.code);
  const winnerCode = target.winner?.code || null;
  return { winnerCode, qualifiedCodes };
}

/** Format a session bound for UI. */
export function formatSessionTime(isoStr, now = Date.now()) {
  if (!isoStr) return "TBD";
  const t = new Date(isoStr).getTime();
  if (!Number.isFinite(t)) return "TBD";
  const d = new Date(t);
  const abs = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const delta = t - now;
  if (Math.abs(delta) < 60_000) return `${abs} (now)`;
  if (delta > 0 && delta < 3600_000) {
    const m = Math.ceil(delta / 60_000);
    return `${abs} (in ${m}m)`;
  }
  if (delta < 0 && delta > -3600_000) {
    const m = Math.ceil(-delta / 60_000);
    return `${abs} (${m}m ago)`;
  }
  return abs;
}
