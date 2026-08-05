/**
 * Persist viewer predictions (localStorage + live API + Pages data/).
 * Never downloads full rankings.json / live.json (tens of MB).
 */

import { pagesDataUrl, resetApiBaseCache } from "./public.js";
import {
  battleResultCodes,
  normalizeSlots,
  scorePrediction,
  slotsAreComplete,
} from "./predictions-score.js";

const LOCAL_KEY = "flagbattle.predictions.v1";
const SESSION_KEY = "flagbattle.predictions.session.v1";
const API_STORAGE_KEY = "flagbattle.apiBase";
const FETCH_MS = 10000;
const API_PING_MS = 2500;

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

function apiCandidates() {
  const out = [];
  const add = (u) => {
    const t = String(u || "")
      .trim()
      .replace(/\/$/, "");
    if (t && !out.includes(t)) out.push(t);
  };
  try {
    add(localStorage.getItem(API_STORAGE_KEY));
  } catch {
    /* ignore */
  }
  if (typeof location !== "undefined") {
    const { protocol, hostname, port, origin } = location;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    ) {
      add(origin);
      add(`${protocol}//${hostname}:${port || "8787"}`);
      add(`${protocol}//${hostname}:8787`);
    }
  }
  return out;
}

async function fetchJsonTimeout(url, ms, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      ...init,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function rememberApi(api) {
  const base = String(api || "").replace(/\/$/, "");
  if (!base) return;
  try {
    localStorage.setItem(API_STORAGE_KEY, base);
  } catch {
    /* ignore */
  }
  resetApiBaseCache();
}

function forgetApi(api) {
  const base = String(api || "").replace(/\/$/, "");
  try {
    const stored = localStorage.getItem(API_STORAGE_KEY);
    if (stored && stored.replace(/\/$/, "") === base) {
      localStorage.removeItem(API_STORAGE_KEY);
      resetApiBaseCache();
    }
  } catch {
    /* ignore */
  }
}

async function probeApiBase(hintApi) {
  const candidates = [];
  const add = (u) => {
    const t = String(u || "")
      .trim()
      .replace(/\/$/, "");
    if (t && !candidates.includes(t)) candidates.push(t);
  };
  add(hintApi);
  for (const c of apiCandidates()) add(c);

  for (const api of candidates) {
    try {
      const health = await fetchJsonTimeout(`${api}/api/health`, API_PING_MS);
      if (health?.ok === true) {
        rememberApi(api);
        return api;
      }
    } catch {
      /* try slim meta as older servers may lack /api/health */
    }
    try {
      const meta = await fetchJsonTimeout(
        `${api}/api/predictions/meta`,
        API_PING_MS
      );
      if (meta && typeof meta === "object") {
        rememberApi(api);
        return api;
      }
    } catch {
      forgetApi(api);
    }
  }
  return "";
}

export async function fetchPredictionsConfig() {
  try {
    const j = await fetchJsonTimeout(
      pagesDataUrl("predictions-config.json"),
      8000
    );
    if (j?.googleClientId) return j;
  } catch {
    /* try API */
  }
  for (const api of apiCandidates()) {
    try {
      const j = await fetchJsonTimeout(
        `${api}/api/predictions/config`,
        API_PING_MS
      );
      if (j) return j;
    } catch {
      /* next */
    }
  }
  return {};
}

/**
 * Slim battle + live context for predictions (never full rankings/live JSON).
 * @returns {{ streams: object[], liveSnap: object|null, board: {entries: object[]} }}
 */
export async function fetchPredictionContext() {
  let streams = [];
  let liveSnap = null;
  let hintApi = "";

  // 1) Pages slim meta (small) — primary path on GitHub Pages.
  try {
    const meta = await fetchJsonTimeout(
      pagesDataUrl("predictions-meta.json"),
      FETCH_MS
    );
    if (Array.isArray(meta?.streams)) streams = meta.streams;
    if (meta?.live && typeof meta.live === "object") liveSnap = meta.live;
    if (meta?.api) hintApi = meta.api;
  } catch {
    /* optional until first publish */
  }

  // 2) Tiny nightbot pointer for API URL (never full live.json).
  if (!hintApi) {
    try {
      const nb = await fetchJsonTimeout(pagesDataUrl("nightbot.json"), 5000);
      if (nb?.api) hintApi = nb.api;
    } catch {
      /* ignore */
    }
  }

  // 3) Live API when reachable (short ping; clear dead tunnels).
  const api = await probeApiBase(hintApi);
  if (api) {
    try {
      const remote = await fetchJsonTimeout(
        `${api}/api/predictions/meta`,
        FETCH_MS
      );
      if (Array.isArray(remote?.streams) && remote.streams.length) {
        streams = remote.streams;
      }
      if (remote?.live && typeof remote.live === "object") {
        liveSnap = remote.live;
      }
    } catch {
      /* keep Pages meta */
    }
  }

  const board = await fetchPredictionsBoard(api);
  return { streams, liveSnap, board };
}

export async function fetchPredictionsBoard(knownApi = "") {
  const local = readLocalStore();
  const candidates = [];
  if (knownApi) candidates.push(`${knownApi}/api/predictions`);
  for (const api of apiCandidates()) {
    const url = `${api}/api/predictions`;
    if (!candidates.includes(url)) candidates.push(url);
  }
  candidates.push(pagesDataUrl("predictions.json"));

  for (const url of candidates) {
    try {
      const j = await fetchJsonTimeout(url, FETCH_MS);
      if (j?.entries) return j;
      if (Array.isArray(j?.predictions)) return { entries: j.predictions };
      if (Array.isArray(j)) return { entries: j };
    } catch {
      /* try next */
    }
  }
  return local;
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

  let hintApi = "";
  try {
    hintApi = localStorage.getItem(API_STORAGE_KEY) || "";
  } catch {
    /* ignore */
  }
  const api = await probeApiBase(hintApi);
  if (api) {
    try {
      const data = await fetchJsonTimeout(`${api}/api/predictions`, FETCH_MS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: session.idToken || "",
          entry,
        }),
      });
      if (data?.entry) return data.entry;
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
