/** Persist stream rankings + poll state (localStorage + live API + Pages data). */

import { apiFetch, pagesDataUrl, resolveApiBase } from "./public.js";

const STREAMS_KEY = "flagbattle.streams.v1";
const LIVE_KEY = "flagbattle.live.v1";

/** When false (Easy teststream), skip localStorage + API writes entirely. */
let persistEnabled = true;

export function setPersistEnabled(on) {
  persistEnabled = Boolean(on);
}

export function isPersistEnabled() {
  return persistEnabled;
}

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
  if (!persistEnabled) return;
  const all = listStreams().filter((s) => s.id !== stream.id);
  all.unshift(stream);
  localStorage.setItem(STREAMS_KEY, JSON.stringify(all.slice(0, 40)));
  syncLive({ type: "stream", stream }).catch(() => {});
}

export function getStream(id) {
  return listStreams().find((s) => s.id === id) || null;
}

export function setLiveSnapshot(snap) {
  if (!persistEnabled) return;
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

function pollKey(streamId) {
  return `flagbattle.poll.${streamId}`;
}

/** In-memory polls when persist is off (Easy teststream). */
const memoryPolls = new Map();

function emptyPoll(streamId) {
  return {
    streamId,
    options: [],
    votes: {},
    voters: {},
    recentVotes: [],
    closed: false,
    updatedAt: Date.now(),
  };
}

export function getLocalPoll(streamId) {
  if (!persistEnabled) {
    return memoryPolls.get(streamId) || emptyPoll(streamId);
  }
  try {
    return (
      JSON.parse(localStorage.getItem(pollKey(streamId)) || "null") ||
      emptyPoll(streamId)
    );
  } catch {
    return emptyPoll(streamId);
  }
}

export async function fetchPoll(streamId) {
  // Teststream / no-persist: never hit live API or Pages.
  if (!persistEnabled) return getLocalPoll(streamId);

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

/** Copy poll tallies to another stream id — keeps every country option. */
export function transferPoll(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return null;
  const prev = getLocalPoll(fromId);
  if (!prev?.options?.length && !Object.keys(prev?.votes || {}).length) {
    return null;
  }
  const next = {
    streamId: toId,
    options: Array.isArray(prev.options) ? prev.options.slice() : [],
    votes: { ...(prev.votes || {}) },
    voters: { ...(prev.voters || {}) },
    recentVotes: Array.isArray(prev.recentVotes) ? prev.recentVotes.slice() : [],
    closed: Boolean(prev.closed),
    updatedAt: Date.now(),
  };
  if (!persistEnabled) {
    memoryPolls.set(toId, next);
    return next;
  }
  localStorage.setItem(pollKey(toId), JSON.stringify(next));
  syncLive({ type: "poll_init", poll: next }).catch(() => {});
  return next;
}

/** Freeze poll after Final — votes stop; options kept for history. */
export function closeLocalPoll(streamId) {
  const prev = getLocalPoll(streamId);
  const next = {
    ...prev,
    streamId,
    closed: true,
    closedAt: new Date().toISOString(),
    updatedAt: Date.now(),
  };
  if (!persistEnabled) {
    memoryPolls.set(streamId, next);
    return next;
  }
  localStorage.setItem(pollKey(streamId), JSON.stringify(next));
  syncLive({ type: "poll_init", poll: next }).catch(() => {});
  return next;
}

/** Top poll places with bonus points (10/5/3/2/1). */
export function rankPollPlaces(poll, placePoints = [10, 5, 3, 2, 1]) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const votes = poll?.votes || {};
  const ranked = [...options]
    .map((o) => ({
      code: o.code,
      name: o.name,
      img: o.img,
      votes: Number(votes[o.code]) || 0,
    }))
    .sort(
      (a, b) =>
        b.votes - a.votes ||
        String(a.name || "").localeCompare(String(b.name || ""))
    );
  return placePoints.map((pts, i) => {
    const row = ranked[i];
    if (!row) return null;
    return {
      rank: i + 1,
      code: row.code,
      name: row.name,
      img: row.img,
      votes: row.votes,
      points: pts,
    };
  }).filter(Boolean);
}

export function initLocalPoll(streamId, options) {
  const prev = getLocalPoll(streamId);
  // Never shrink the option list — union so eliminated countries stay.
  const byCode = new Map();
  for (const o of prev.options || []) {
    if (o?.code) byCode.set(String(o.code).toLowerCase(), o);
  }
  for (const o of options || []) {
    if (o?.code) byCode.set(String(o.code).toLowerCase(), o);
  }
  const mergedOptions = [...byCode.values()];
  const votes = Object.fromEntries(mergedOptions.map((o) => [o.code, 0]));
  for (const [code, n] of Object.entries(prev.votes || {})) {
    votes[code] = Number(n) || 0;
  }

  const hadVotes =
    (prev.voters && Object.keys(prev.voters).length > 0) ||
    Object.values(prev.votes || {}).some((n) => Number(n) > 0);

  const merged = {
    streamId,
    options: mergedOptions,
    votes,
    voters: { ...(prev.voters || {}) },
    recentVotes: Array.isArray(prev.recentVotes) ? prev.recentVotes.slice() : [],
    closed: Boolean(prev.closed),
    updatedAt: hadVotes ? prev.updatedAt || Date.now() : Date.now(),
  };

  if (!persistEnabled) {
    memoryPolls.set(streamId, merged);
    return merged;
  }
  localStorage.setItem(pollKey(streamId), JSON.stringify(merged));
  syncLive({ type: "poll_init", poll: merged }).catch(() => {});
  return merged;
}

/**
 * Seed a few demo votes for Easy teststream HUD preview (no save).
 * @param {string} streamId
 */
export function seedTeststreamPollDemo(streamId) {
  if (persistEnabled) return getLocalPoll(streamId);
  const poll = getLocalPoll(streamId);
  if (!poll.options?.length) return poll;
  if (poll.recentVotes?.length) return poll;

  const demoVoters = [
    { voter: "Tyler-u5j7k", code: "br" },
    { voter: "MayaLive", code: "jp" },
    { voter: "FlagFan", code: "kr" },
    { voter: "GeoKid", code: "us" },
    { voter: "ArenaChat", code: "br" },
  ];
  const byCode = new Map(
    poll.options.map((o) => [String(o.code).toLowerCase(), o])
  );
  for (const row of demoVoters) {
    const opt = byCode.get(row.code);
    if (!opt) continue;
    const vid = `demo:${row.voter}`;
    const prev = poll.voters[vid];
    if (prev && poll.votes[prev] > 0) poll.votes[prev] -= 1;
    poll.voters[vid] = row.code;
    poll.votes[row.code] = (poll.votes[row.code] || 0) + 1;
    poll.recentVotes = [
      {
        voter: row.voter,
        code: row.code,
        name: opt.name,
        img: opt.img || `https://flagcdn.com/w40/${row.code}.png`,
        at: Date.now(),
      },
      ...(poll.recentVotes || []),
    ].slice(0, 5);
  }
  poll.updatedAt = Date.now();
  memoryPolls.set(streamId, poll);
  return poll;
}

function localPollVote(streamId, code, voterId, voterName) {
  const poll = getLocalPoll(streamId);
  if (poll.closed || !poll.options?.length) {
    return poll;
  }
  const prev = poll.voters[voterId];
  if (prev && poll.votes[prev] > 0) poll.votes[prev] -= 1;
  poll.voters[voterId] = code;
  poll.votes[code] = (poll.votes[code] || 0) + 1;
  const opt = (poll.options || []).find(
    (o) => String(o.code).toLowerCase() === String(code).toLowerCase()
  );
  const who = String(voterName || voterId || "Viewer")
    .replace(/^nb:/, "")
    .replace(/^yt:/, "")
    .replace(/^demo:/, "")
    .slice(0, 40);
  const entry = {
    voter: who,
    code,
    name: opt?.name || String(code).toUpperCase(),
    img: opt?.img || `https://flagcdn.com/w40/${code}.png`,
    at: Date.now(),
  };
  poll.recentVotes = [
    entry,
    ...(Array.isArray(poll.recentVotes) ? poll.recentVotes : []).filter(
      (r) => r && r.voter !== who
    ),
  ].slice(0, 5);
  poll.updatedAt = Date.now();
  if (!persistEnabled) {
    memoryPolls.set(streamId, poll);
    return poll;
  }
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
