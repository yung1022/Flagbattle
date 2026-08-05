/**
 * Persist viewer predictions (localStorage + live API + Pages data/).
 */

import { apiFetch, pagesDataUrl, resolveApiBase } from "./public.js";
import {
  battleResultCodes,
  normalizeSlots,
  scorePrediction,
  slotsAreComplete,
} from "./predictions-score.js";

const LOCAL_KEY = "flagbattle.predictions.v1";
const SESSION_KEY = "flagbattle.predictions.session.v1";

export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveSession(session) {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      userId: session.userId,
      name: session.name,
      email: session.email || "",
      picture: session.picture || "",
      idToken: session.idToken || "",
      at: Date.now(),
    })
  );
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function readLocalStore() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{"entries":[]}');
  } catch {
    return { entries: [] };
  }
}

function writeLocalStore(store) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
}

export function upsertLocalPrediction(entry) {
  const store = readLocalStore();
  const entries = Array.isArray(store.entries) ? store.entries : [];
  const idx = entries.findIndex(
    (e) => e.userId === entry.userId && e.battleId === entry.battleId
  );
  if (idx >= 0) entries[idx] = entry;
  else entries.unshift(entry);
  store.entries = entries.slice(0, 200);
  store.updatedAt = new Date().toISOString();
  writeLocalStore(store);
  return entry;
}

export function getLocalPrediction(userId, battleId) {
  const store = readLocalStore();
  return (
    (store.entries || []).find(
      (e) => e.userId === userId && e.battleId === battleId
    ) || null
  );
}

export async function fetchPredictionsConfig() {
  try {
    const res = await fetch(pagesDataUrl("predictions-config.json"), {
      cache: "no-store",
    });
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  const fromApi = await apiFetch("/api/predictions/config");
  return fromApi || {};
}

export async function fetchPredictionsBoard() {
  const fromApi = await apiFetch("/api/predictions");
  if (fromApi?.entries) return fromApi;
  try {
    const res = await fetch(pagesDataUrl("predictions.json"), {
      cache: "no-store",
    });
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return readLocalStore();
}

/**
 * Submit / update a prediction. Always writes localStorage; POSTs when API up.
 */
export async function submitPrediction({
  session,
  battleId,
  slots,
  locked = false,
}) {
  if (!session?.userId) throw new Error("Sign in with Google first.");
  if (!battleId) throw new Error("No battle to predict.");
  const normalized = normalizeSlots(slots);
  if (!slotsAreComplete(normalized)) {
    throw new Error("Pick 5 different countries for all slots.");
  }

  const entry = {
    userId: session.userId,
    name: session.name || "Player",
    email: session.email || "",
    picture: session.picture || "",
    battleId,
    slots: normalized,
    submittedAt: new Date().toISOString(),
    locked: Boolean(locked),
  };
  upsertLocalPrediction(entry);

  const base = await resolveApiBase();
  if (base) {
    try {
      const res = await fetch(`${base}/api/predictions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: session.idToken || "",
          entry,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.entry || entry;
      }
    } catch {
      /* keep local */
    }
  }
  return entry;
}

/** Merge board + local, score against target battle results. */
export function buildLeaderboard(board, target) {
  const result = battleResultCodes(target);
  const byUser = new Map();
  const lists = [board?.entries || [], readLocalStore().entries || []];
  for (const list of lists) {
    for (const e of list) {
      if (!e?.userId || !e?.battleId) continue;
      if (target?.battleId && e.battleId !== target.battleId) continue;
      const prev = byUser.get(e.userId);
      const newer =
        !prev ||
        String(e.submittedAt || "") >= String(prev.submittedAt || "");
      if (newer) byUser.set(e.userId, e);
    }
  }

  const rows = [...byUser.values()].map((e) => {
    const score = scorePrediction(e.slots, result);
    return {
      ...e,
      score,
    };
  });
  rows.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return rows;
}

export function decodeGoogleCredential(credential) {
  if (!credential || typeof credential !== "string") return null;
  try {
    const payload = credential.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(json);
    return {
      userId: data.sub,
      name: data.name || data.given_name || "Player",
      email: data.email || "",
      picture: data.picture || "",
      idToken: credential,
    };
  } catch {
    return null;
  }
}
