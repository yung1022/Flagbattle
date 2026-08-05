/**
 * Prediction slots + scoring rules.
 * Slot 1→100, 2→50, 3→25, 4→15, 5→10 if that country wins the battle.
 * +5 per selected country that qualifies.
 */

export const SLOT_POINTS = [100, 50, 25, 15, 10];
export const QUALIFY_BONUS = 5;
export const SLOT_COUNT = 5;

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
      break; // only one winner
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

/**
 * Pick which battle a prediction targets from paired battles (+ optional live snap).
 * Prefer live/open qualifying; else pending Final; else newest finished (view-only).
 */
export function predictionBattleTarget(battles, liveSnap = null) {
  const list = Array.isArray(battles) ? battles : [];

  // Live qualifying stream takes priority.
  if (
    liveSnap?.streamId &&
    (liveSnap.mode === "qualifying" || !liveSnap.mode) &&
    liveSnap.phase !== "finished"
  ) {
    const existing = list.find(
      (b) =>
        b.qualifying?.id === liveSnap.streamId ||
        b.id === liveSnap.streamId ||
        String(b.id || "").startsWith(liveSnap.streamId)
    );
    if (existing) {
      const summary = summarizeBattle(existing, "open");
      summary.battleId = liveSnap.streamId;
      summary.locked = false;
      return summary;
    }
    return {
      battleId: liveSnap.streamId,
      status: "open",
      label: "Live qualifying",
      startedAt: liveSnap.startedAt || null,
      qualifyingEnded: false,
      finalEnded: false,
      locked: false,
      qualified: Array.isArray(liveSnap.qualified) ? liveSnap.qualified : [],
      winner: null,
      battle: null,
    };
  }

  if (!list.length) return null;

  const openQual = list.find(
    (b) =>
      b.qualifying &&
      !b.qualifying.endedAt &&
      !(b.final?.final?.ranking?.length || b.ended)
  );
  if (openQual) return summarizeBattle(openQual, "open");

  const pendingFinal = list.find(
    (b) =>
      b.qualifying?.endedAt &&
      !(b.final?.final?.ranking?.length || b.ended) &&
      !b.final?.endedAt
  );
  if (pendingFinal) return summarizeBattle(pendingFinal, "pending-final");

  const newest = [...list].sort((a, b) =>
    (b.startedAt || "").localeCompare(a.startedAt || "")
  )[0];
  if (newest && (newest.ended || newest.final?.final?.ranking?.length)) {
    return summarizeBattle(newest, "finished");
  }
  if (newest) return summarizeBattle(newest, "open");
  return null;
}

function summarizeBattle(battle, status) {
  const qual = battle.qualifying;
  const fin = battle.final;
  const battleId =
    qual?.id ||
    (battle.id && String(battle.id).split("+")[0]) ||
    fin?.id ||
    battle.id;
  const qualified = qual?.qualified || fin?.qualified || [];
  const winner =
    battle.winner || fin?.winner || fin?.final?.winner || null;
  return {
    battleId,
    status,
    label: battleLabel(battle),
    startedAt: battle.startedAt || qual?.startedAt || fin?.startedAt || null,
    qualifyingEnded: Boolean(qual?.endedAt),
    finalEnded: Boolean(
      battle.ended || fin?.endedAt || fin?.final?.ranking?.length
    ),
    locked: Boolean(qual?.endedAt),
    qualified: qualified.map((q) => ({
      code: q.code,
      name: q.name,
      img: q.img,
    })),
    winner: winner
      ? { code: winner.code, name: winner.name, img: winner.img }
      : null,
    battle,
  };
}

function battleLabel(battle) {
  const when = battle.startedAt ? new Date(battle.startedAt) : null;
  if (when && !Number.isNaN(when.getTime())) {
    return when.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return battle.id || "Battle";
}

/** Resolve result fields for scoring from a target summary or raw battle. */
export function battleResultCodes(target) {
  if (!target) return { winnerCode: null, qualifiedCodes: [] };
  const qualifiedCodes = (target.qualified || []).map((q) => q.code);
  const winnerCode = target.winner?.code || null;
  return { winnerCode, qualifiedCodes };
}
