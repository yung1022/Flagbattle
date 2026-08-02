/** Persist stream rankings + poll state (localStorage + live API + Pages data). */

import { apiFetch, pagesDataUrl, resolveApiBase } from "./public.js";

const STREAMS_KEY = "flagbattle.streams.v1";
const LIVE_KEY = "flagbattle.live.v1";

export function newStreamId() {
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listStreams() {
  try {
    return JSON.parse(localStorage.getItem(STREAMS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveStream(stream) {
  const all = listStreams().filter((s) => s.id !== stream.id);
  all.unshift(stream);
  localStorage.setItem(STREAMS_KEY, JSON.stringify(all.slice(0, 40)));
  syncLive({ type: "stream", stream }).catch(() => {});
}

export function getStream(id) {
  return listStreams().find((s) => s.id === id) || null;
}

export function setLiveSnapshot(snap) {
  localStorage.setItem(LIVE_KEY, JSON.stringify(snap));
  syncLive({ type: "live", live: snap }).catch(() => {});
}

export function getLiveSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(LIVE_KEY) || "null");
  } catch {
    return null;
  }
}

async function syncLive(payload) {
  if (typeof fetch !== "function") return;
  // Game always posts to same-origin server when hosted locally.
  try {
    await fetch("/api/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* offline / Pages */
  }
}

export async function fetchLiveFromApi() {
  const fromApi = await apiFetch("/api/live");
  if (fromApi) return fromApi;
  try {
    const res = await fetch(pagesDataUrl("live.json"), { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}

function streamCompleteness(s) {
  let n = 0;
  if (s?.endedAt) n += 8;
  if (s?.final?.ranking?.length) n += 4 + Math.min(s.final.ranking.length, 50);
  if (s?.qualified?.length) n += 2;
  if (s?.rounds?.length) n += 1;
  if (s?.winner) n += 1;
  return n;
}

/** Newest-first union; prefer the more complete record per stream id. */
export function mergeStreamLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (!s?.id) continue;
      const prev = byId.get(s.id);
      if (!prev || streamCompleteness(s) >= streamCompleteness(prev)) {
        byId.set(s.id, s);
      }
    }
  }
  return [...byId.values()].sort((a, b) =>
    (b.startedAt || "").localeCompare(a.startedAt || "")
  );
}

export async function fetchStreamsFromApi() {
  const fromApi = await apiFetch("/api/rankings");
  let fromPages = null;
  try {
    const res = await fetch(pagesDataUrl("rankings.json"), { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) fromPages = data;
    }
  } catch {
    /* ignore */
  }

  const live = await fetchLiveFromApi();
  const fromLive = Array.isArray(live?.streams) ? live.streams : null;

  const merged = mergeStreamLists(fromApi, fromPages, fromLive);
  return merged.length ? merged : null;
}

export async function submitPollVote(streamId, code, voterId) {
  const body = JSON.stringify({ streamId, code, voterId });
  const base = await resolveApiBase();
  if (base) {
    try {
      const res = await fetch(`${base}/api/poll/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) return await res.json();
    } catch {
      /* fall through */
    }
  }
  return localPollVote(streamId, code, voterId);
}

export async function fetchPoll(streamId) {
  const fromApi = await apiFetch(
    `/api/poll?streamId=${encodeURIComponent(streamId)}`
  );
  if (fromApi?.options || fromApi?.votes) return fromApi;

  try {
    const safe = String(streamId).replace(/[^a-zA-Z0-9_-]/g, "");
    const res = await fetch(pagesDataUrl(`polls/${safe}.json`), {
      cache: "no-store",
    });
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return getLocalPoll(streamId);
}

function pollKey(streamId) {
  return `flagbattle.poll.${streamId}`;
}

export function getLocalPoll(streamId) {
  try {
    return (
      JSON.parse(localStorage.getItem(pollKey(streamId)) || "null") || {
        streamId,
        options: [],
        votes: {},
        voters: {},
      }
    );
  } catch {
    return { streamId, options: [], votes: {}, voters: {} };
  }
}

export function initLocalPoll(streamId, options) {
  const prev = getLocalPoll(streamId);
  const sameOptions =
    Array.isArray(prev?.options) &&
    prev.options.length === options.length &&
    options.every((o, i) => prev.options[i]?.code === o.code);

  // Preserve votes if poll already open for this stream (idempotent).
  const hadVotes =
    prev?.streamId === streamId &&
    ((prev.voters && Object.keys(prev.voters).length > 0) ||
      Object.values(prev.votes || {}).some((n) => Number(n) > 0));

  if (hadVotes || (sameOptions && prev?.options?.length)) {
    const merged = {
      streamId,
      options,
      votes: { ...Object.fromEntries(options.map((o) => [o.code, 0])), ...(prev.votes || {}) },
      voters: { ...(prev.voters || {}) },
      updatedAt: prev.updatedAt || Date.now(),
    };
    localStorage.setItem(pollKey(streamId), JSON.stringify(merged));
    // Soft sync options only — server merges and keeps tallies.
    syncLive({ type: "poll_init", poll: merged }).catch(() => {});
    return merged;
  }

  const poll = {
    streamId,
    options,
    votes: Object.fromEntries(options.map((o) => [o.code, 0])),
    voters: {},
    updatedAt: Date.now(),
  };
  localStorage.setItem(pollKey(streamId), JSON.stringify(poll));
  syncLive({ type: "poll_init", poll }).catch(() => {});
  return poll;
}

function localPollVote(streamId, code, voterId) {
  const poll = getLocalPoll(streamId);
  const prev = poll.voters[voterId];
  if (prev && poll.votes[prev] > 0) poll.votes[prev] -= 1;
  poll.voters[voterId] = code;
  poll.votes[code] = (poll.votes[code] || 0) + 1;
  poll.updatedAt = Date.now();
  localStorage.setItem(pollKey(streamId), JSON.stringify(poll));
  return poll;
}

export function voterId() {
  const key = "flagbattle.voterId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `v_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, id);
  }
  return id;
}
