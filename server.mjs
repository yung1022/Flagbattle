/**
 * Static site + tiny API for rankings / live poll / channel stats.
 * Mirrors history into data/ and syncs to GitHub for Pages.
 *   node server.mjs
 *   PORT=5173 node server.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  githubSyncEnabled,
  mirrorAndSync,
  enqueueGithubFile,
} from "./github-sync.mjs";
import { COUNTRIES, resolveCountryQuery } from "./js/countries.js";

const COUNTRY_BY_CODE = new Map(
  COUNTRIES.map((c) => [String(c.code).toLowerCase(), c])
);

let announceQueue = Promise.resolve();
let lastAnnounceText = "";
let lastAnnounceAt = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const DATA = path.join(ROOT, ".data");
const PUBLIC_DATA = path.join(ROOT, "data");
const LIVE_FILE = path.join(DATA, "live.json");
const RANK_FILE = path.join(DATA, "rankings.json");
const PRED_FILE = path.join(DATA, "predictions.json");
const PRED_CONFIG_FILE = path.join(PUBLIC_DATA, "predictions-config.json");
const PRED_META_FILE = path.join(PUBLIC_DATA, "predictions-meta.json");
const POLL_DIR = path.join(DATA, "polls");
const CHANNEL_CACHE = path.join(DATA, "channel.json");

fs.mkdirSync(POLL_DIR, { recursive: true });
fs.mkdirSync(path.join(PUBLIC_DATA, "polls"), { recursive: true });
loadEnvFile(path.join(ROOT, "stream/.env"));
loadEnvFile(path.join(ROOT, ".env"));

/** Public tunnel URL for viewer votes (set by go-live / cloudflared). */
let publicApi =
  process.env.PUBLIC_API ||
  process.env.PUBLIC_API_URL ||
  process.env.TUNNEL_URL ||
  null;

let syncTimer = null;
let githubTimer = null;
let dirtyLive = false;
let dirtyRank = false;
let dirtyPredictions = false;
const dirtyPolls = new Set();
/** GitHub publish intents (survive local-only flushes). */
let githubLive = false;
let githubRank = false;
let githubPredictions = false;
const githubPolls = new Set();

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".md": "text/markdown; charset=utf-8",
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function send(res, status, body, type = "application/json") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function pollPath(streamId) {
  const safe = String(streamId).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(POLL_DIR, `${safe}.json`);
}

function publicPollRel(streamId) {
  const safe = String(streamId).replace(/[^a-zA-Z0-9_-]/g, "");
  return `data/polls/${safe}.json`;
}

/** Drop per-round rankings so predictions can load without multi-MB JSON. */
function slimCountry(c) {
  if (!c || typeof c !== "object") return null;
  return {
    code: c.code,
    name: c.name,
    img: c.img,
  };
}

function slimStreamForPredictions(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: s.id,
    title: s.title,
    mode: s.mode,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    winner: slimCountry(s.winner),
    qualified: Array.isArray(s.qualified)
      ? s.qualified.map(slimCountry).filter(Boolean)
      : undefined,
    // Preserve lengths only — used by battle pairing / lock heuristics.
    rounds: Array.isArray(s.rounds) ? s.rounds.map(() => ({})) : undefined,
    final: s.final
      ? {
          at: s.final.at,
          ranking: Array.isArray(s.final.ranking) ? [{}] : undefined,
          winner: slimCountry(s.final.winner),
        }
      : undefined,
  };
}

function buildPredictionsMeta(liveDoc = null) {
  const live = liveDoc || readJson(LIVE_FILE, { live: null, streams: [] });
  const streamsRaw = live.streams?.length
    ? live.streams
    : readJson(RANK_FILE, []);
  const streams = (Array.isArray(streamsRaw) ? streamsRaw : [])
    .slice(-40)
    .map(slimStreamForPredictions)
    .filter(Boolean);
  const snap = live.live || null;
  return {
    updatedAt: new Date().toISOString(),
    api: publicApi || live.api || null,
    streams,
    live: snap
      ? {
          streamId: snap.streamId || null,
          title: snap.title || null,
          mode: snap.mode || null,
          phase: snap.phase || null,
          startedAt: snap.startedAt || null,
          qualifyingRemainingMs: snap.qualifyingRemainingMs ?? null,
          qualified: Array.isArray(snap.qualified)
            ? snap.qualified.map(slimCountry).filter(Boolean)
            : [],
          winner: slimCountry(snap.winner),
          updatedAt: snap.updatedAt || null,
        }
      : null,
  };
}

function writePredictionsMeta(liveDoc = null) {
  const meta = buildPredictionsMeta(liveDoc);
  writeJson(PRED_META_FILE, meta);
  return meta;
}

/** Trailing debounce for local data/ mirrors + rare GitHub publishes. */
const LOCAL_SYNC_MS = Number(process.env.LOCAL_SYNC_DEBOUNCE_MS || 2_000);
const GITHUB_SYNC_MS = Number(process.env.GITHUB_SYNC_DEBOUNCE_MS || 90_000);

function schedulePublicSync({
  forceRank = false,
  forceLive = false,
  forcePredictions = false,
  pollId = null,
  github = false,
} = {}) {
  if (forceRank) {
    dirtyRank = true;
    if (github) githubRank = true;
  }
  if (forceLive) {
    dirtyLive = true;
    if (github) githubLive = true;
  }
  if (forcePredictions) {
    dirtyPredictions = true;
    if (github) githubPredictions = true;
  }
  if (pollId) {
    dirtyPolls.add(pollId);
    if (github) githubPolls.add(pollId);
  }

  // Always flush local data/ soon (tunnel API is source of truth mid-stream).
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    flushLocalPublicData();
  }, LOCAL_SYNC_MS);

  // Coalesce GitHub Contents API puts — frequent main commits cancel Pages builds.
  if (githubLive || githubRank || githubPredictions || githubPolls.size) {
    if (githubTimer) clearTimeout(githubTimer);
    githubTimer = setTimeout(() => {
      githubTimer = null;
      flushGithubPublicData();
    }, GITHUB_SYNC_MS);
  }
}

function flushLocalPublicData() {
  const live = readJson(LIVE_FILE, { live: null, streams: [] });
  const payload = {
    ...live,
    api: publicApi,
    updatedAt: Date.now(),
  };
  const wroteLiveOrRank = dirtyLive || dirtyRank;

  if (dirtyLive) {
    dirtyLive = false;
    writeJson(path.join(PUBLIC_DATA, "live.json"), payload);
  }

  if (dirtyRank) {
    dirtyRank = false;
    const streams = live.streams?.length
      ? live.streams
      : readJson(RANK_FILE, []);
    writeJson(path.join(PUBLIC_DATA, "rankings.json"), streams);
    writeJson(RANK_FILE, streams);
  }

  if (wroteLiveOrRank) {
    writePredictionsMeta(live);
  }

  if (dirtyPredictions) {
    dirtyPredictions = false;
    const preds = readJson(PRED_FILE, { entries: [], updatedAt: null });
    writeJson(path.join(PUBLIC_DATA, "predictions.json"), preds);
  }

  for (const streamId of dirtyPolls) {
    const poll = readJson(pollPath(streamId), null);
    if (!poll) continue;
    writeJson(path.join(ROOT, publicPollRel(streamId)), poll);
  }
  dirtyPolls.clear();
}

function flushGithubPublicData() {
  // Ensure local files are current before publishing.
  flushLocalPublicData();

  const live = readJson(LIVE_FILE, { live: null, streams: [] });
  const newest = live.streams?.[0];
  const streamFinished = Boolean(newest?.endedAt);
  const payload = {
    ...live,
    api: publicApi,
    updatedAt: Date.now(),
  };

  let publishPredMeta = false;

  if (githubLive) {
    githubLive = false;
    publishPredMeta = true;
    writeJson(path.join(PUBLIC_DATA, "live.json"), payload);
    enqueueGithubFile(
      "data/live.json",
      JSON.stringify(payload, null, 2),
      `chore(data): update live snapshot ${new Date().toISOString()}`
    );
  }

  if (githubRank && streamFinished) {
    githubRank = false;
    publishPredMeta = true;
    const streams = live.streams?.length
      ? live.streams
      : readJson(RANK_FILE, []);
    writeJson(path.join(PUBLIC_DATA, "rankings.json"), streams);
    enqueueGithubFile(
      "data/rankings.json",
      JSON.stringify(streams, null, 2),
      `chore(data): save stream rankings ${new Date().toISOString()}`
    );
  } else if (githubRank && !streamFinished) {
    // Defer until a finished stream is present.
    githubRank = true;
  }

  if (publishPredMeta) {
    const meta = writePredictionsMeta(live);
    enqueueGithubFile(
      "data/predictions-meta.json",
      JSON.stringify(meta),
      `chore(data): update predictions meta ${new Date().toISOString()}`
    );
  }

  if (githubPredictions) {
    githubPredictions = false;
    const preds = readJson(PRED_FILE, { entries: [], updatedAt: null });
    writeJson(path.join(PUBLIC_DATA, "predictions.json"), preds);
    enqueueGithubFile(
      "data/predictions.json",
      JSON.stringify(preds, null, 2),
      `chore(data): update predictions ${new Date().toISOString()}`
    );
  }

  for (const streamId of githubPolls) {
    const poll = readJson(pollPath(streamId), null);
    if (!poll) continue;
    const rel = publicPollRel(streamId);
    writeJson(path.join(ROOT, rel), poll);
    enqueueGithubFile(
      rel,
      JSON.stringify(poll, null, 2),
      `chore(data): poll ${streamId}`
    );
  }
  githubPolls.clear();
}

function flushPublicSync({ github = false } = {}) {
  if (github) flushGithubPublicData();
  else flushLocalPublicData();
}

/** Merge poll_init into existing tallies — never wipe votes or drop countries. */
function mergePoll(existing, incoming) {
  if (!existing?.options?.length && !incoming?.options?.length) {
    return incoming || existing;
  }
  const byCode = new Map();
  for (const o of existing?.options || []) {
    if (o?.code) byCode.set(String(o.code).toLowerCase(), o);
  }
  for (const o of incoming?.options || []) {
    if (o?.code) byCode.set(String(o.code).toLowerCase(), o);
  }
  const options = [...byCode.values()];
  const votes = Object.fromEntries(options.map((o) => [o.code, 0]));
  for (const [code, n] of Object.entries(existing?.votes || {})) {
    votes[code] = Number(n) || 0;
  }
  for (const [code, n] of Object.entries(incoming?.votes || {})) {
    votes[code] = Math.max(votes[code] || 0, Number(n) || 0);
  }
  return {
    streamId: incoming?.streamId || existing?.streamId,
    options,
    votes,
    voters: { ...(existing?.voters || {}), ...(incoming?.voters || {}) },
    closed: Boolean(incoming?.closed ?? existing?.closed),
    closedAt: incoming?.closedAt || existing?.closedAt || null,
    updatedAt: Date.now(),
  };
}

/** Nightbot sends: name=x&displayName=y&provider=youtube&providerId=… */
function parseNightbotUserHeader(raw) {
  if (!raw) return null;
  try {
    const params = new URLSearchParams(String(raw));
    return {
      name: params.get("name") || "",
      displayName: params.get("displayName") || "",
      provider: params.get("provider") || "",
      providerId: params.get("providerId") || "",
    };
  } catch {
    return null;
  }
}

function applyPollVote({ streamId, code, voterId, voterName, avatarUrl }) {
  if (!streamId || !code || !voterId) {
    return {
      ok: false,
      status: 400,
      error: !code
        ? "usage"
        : !streamId
          ? "no_stream"
          : "streamId, code, voterId required",
    };
  }
  if (code.length !== 2 || !COUNTRY_BY_CODE.has(code)) {
    return { ok: false, status: 400, error: "unknown_country" };
  }
  const poll = readJson(pollPath(streamId), {
    streamId,
    options: [],
    votes: {},
    voters: {},
    voterStats: {},
    recentVotes: [],
  });
  if (!poll.options?.length) {
    return { ok: false, status: 409, error: "poll_closed" };
  }
  if (poll.closed) {
    return { ok: false, status: 409, error: "poll_closed" };
  }
  const allowed = new Set(
    poll.options.map((o) => String(o.code || "").toLowerCase())
  );
  if (!allowed.has(code)) {
    return { ok: false, status: 400, error: "not_an_option" };
  }
  const country = COUNTRY_BY_CODE.get(code);
  // Unlimited votes: every cast adds +1 (same voter can vote again).
  poll.voters[voterId] = code;
  poll.votes[code] = (poll.votes[code] || 0) + 1;
  const who = String(voterName || voterId || "Viewer")
    .replace(/^nb:/, "")
    .replace(/^yt:/, "")
    .slice(0, 40);
  const avatar = String(avatarUrl || "").trim().slice(0, 500);
  if (!poll.voterStats || typeof poll.voterStats !== "object") {
    poll.voterStats = {};
  }
  const prevStat = poll.voterStats[voterId] || { count: 0 };
  const voteCount = (Number(prevStat.count) || 0) + 1;
  poll.voterStats[voterId] = {
    name: who,
    avatar: avatar || prevStat.avatar || "",
    count: voteCount,
    lastAt: Date.now(),
  };
  const entry = {
    voter: who,
    voterId,
    code,
    name: country?.name || code.toUpperCase(),
    img: `https://flagcdn.com/w40/${code}.png`,
    avatar: avatar || prevStat.avatar || "",
    at: Date.now(),
  };
  const prevRecent = Array.isArray(poll.recentVotes) ? poll.recentVotes : [];
  poll.recentVotes = [entry, ...prevRecent].slice(0, 5);
  poll.updatedAt = Date.now();
  writeJson(pollPath(streamId), poll);
  schedulePublicSync({ pollId: streamId, github: true });
  return {
    ok: true,
    status: 200,
    error: null,
    poll,
    country,
    voteCount,
  };
}

/** Plain-text reply for Nightbot urlfetch (< 400 chars). */
function formatVoteText(result, voterLabel) {
  const who = String(voterLabel || "Viewer").slice(0, 40);
  if (result.ok) {
    const name = result.country?.name || "OK";
    const n = Number(result.voteCount) || 0;
    const tally = n > 1 ? ` (${n} votes)` : "";
    return `${who} voted ${name} successfully${tally}. Flag may take up to ~30s to spawn.`.slice(
      0,
      200
    );
  }
  switch (result.error) {
    case "usage":
      return "Usage: !vote Japan  or  !vote jp";
    case "unknown_country":
    case "not_an_option":
      return `${who} country not found — try a name or 2-letter code.`;
    case "poll_closed":
      return `${who} poll is closed (opens at Qualifying, ends after Final).`;
    case "no_stream":
      return `${who} poll is offline — wait for the live stream.`;
    default:
      return `${who} vote failed — try again.`;
  }
}

function writeNightbotPointer() {
  const live = readJson(LIVE_FILE, { live: null, streams: [] });
  const payload = {
    api: publicApi || null,
    streamId: live?.live?.streamId || null,
    updatedAt: Date.now(),
  };
  writeJson(path.join(PUBLIC_DATA, "nightbot.json"), payload);
  if (githubSyncEnabled()) {
    enqueueGithubFile(
      "data/nightbot.json",
      JSON.stringify(payload, null, 2),
      `chore(data): nightbot vote pointer`
    );
  }
}

function seedFromPublicData() {
  const pubRank = path.join(PUBLIC_DATA, "rankings.json");
  if (!fs.existsSync(RANK_FILE) && fs.existsSync(pubRank)) {
    writeJson(RANK_FILE, readJson(pubRank, []));
  }
  const pubLive = path.join(PUBLIC_DATA, "live.json");
  if (!fs.existsSync(LIVE_FILE) && fs.existsSync(pubLive)) {
    const live = readJson(pubLive, { live: null, streams: [] });
    writeJson(LIVE_FILE, { live: live.live, streams: live.streams || [] });
    if (live.api && !publicApi) publicApi = live.api;
  }
  const pubPred = path.join(PUBLIC_DATA, "predictions.json");
  if (!fs.existsSync(PRED_FILE) && fs.existsSync(pubPred)) {
    writeJson(PRED_FILE, readJson(pubPred, { entries: [] }));
  }
  if (!fs.existsSync(PRED_FILE)) {
    writeJson(PRED_FILE, { entries: [], updatedAt: null });
  }
  if (!fs.existsSync(PRED_CONFIG_FILE)) {
    writeJson(PRED_CONFIG_FILE, {
      googleClientId:
        process.env.GOOGLE_PREDICTIONS_CLIENT_ID ||
        process.env.GOOGLE_CLIENT_ID ||
        "",
    });
  }
}

seedFromPublicData();

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/api/health" && req.method === "GET") {
    return send(res, 200, { ok: true, api: publicApi, updatedAt: Date.now() });
  }

  if (url.pathname === "/api/live" && req.method === "GET") {
    const cur = readJson(LIVE_FILE, { live: null, streams: [] });
    return send(res, 200, { ...cur, api: publicApi, updatedAt: Date.now() });
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await parseBody(req);
    if (body.api) {
      publicApi = String(body.api).replace(/\/$/, "");
      process.env.PUBLIC_API = publicApi;
      dirtyLive = true;
      // Tunnel URL must land on Pages so phones can find the API.
      schedulePublicSync({ forceLive: true, github: true });
      flushPublicSync({ github: true });
      writeNightbotPointer();
    }
    return send(res, 200, { ok: true, api: publicApi });
  }

  if (url.pathname === "/api/live" && req.method === "POST") {
    const body = await parseBody(req);
    const cur = readJson(LIVE_FILE, { live: null, streams: [] });
    if (body.type === "live") {
      cur.live = body.live;
      // Do not auto-seed from live.qualified — game opens the full-country
      // poll at Qualifying start and carries it through Final (never shrinks).
      // Champion screen uses phase "finished" during the 1-minute winner hold
      // (status winner_hold, endedAt still null). Only close after the hold.
      const holdActive =
        body.live?.streamStatus === "winner_hold" ||
        (Number(body.live?.winnerHoldRemainingMs) || 0) > 0;
      const streamDone =
        !holdActive &&
        (body.live?.streamStatus === "finished" ||
          Boolean(body.live?.endedAt));
      // Safety net: if the finished live snapshot arrives without a matching
      // stream save (race / dropped POST), still close the stream so rankings
      // persist and go-live history is not lost.
      if (streamDone && body.live?.streamId) {
        const idx = (cur.streams || []).findIndex(
          (s) => s.id === body.live.streamId
        );
        if (idx >= 0 && !cur.streams[idx].endedAt) {
          const s = { ...cur.streams[idx] };
          s.endedAt = body.live.endedAt || new Date().toISOString();
          if (Array.isArray(body.live.qualified) && body.live.qualified.length) {
            s.qualified = body.live.qualified.map((q) => ({
              code: q.code,
              name: q.name,
              img: q.img,
            }));
          }
          if (body.live.winner && !s.winner) {
            s.winner = {
              code: body.live.winner.code,
              name: body.live.winner.name,
              img: body.live.winner.img,
            };
            if (!s.final?.ranking?.length) {
              s.final = {
                ranking: [{ rank: 1, ...s.winner }],
                winner: s.winner,
                at: s.endedAt,
                recovered: true,
              };
            }
          }
          if (!s.mode) {
            s.mode = s.final?.ranking?.length ? "final" : "qualifying";
          }
          if (s.status === "winner_hold" || s.status === "live") {
            s.status = "finished";
          }
          cur.streams[idx] = s;
          writeJson(RANK_FILE, cur.streams);
          schedulePublicSync({
            forceRank: true,
            forceLive: true,
            github: true,
          });
          if (githubTimer) clearTimeout(githubTimer);
          githubTimer = null;
          writeJson(LIVE_FILE, cur);
          flushGithubPublicData();
          return send(res, 200, { ok: true });
        }
      }
      schedulePublicSync({
        forceLive: true,
        github: streamDone,
      });
      if (streamDone) {
        // Don't wait the long coalesce window once a stream is done.
        if (githubTimer) clearTimeout(githubTimer);
        githubTimer = null;
        writeJson(LIVE_FILE, cur);
        flushGithubPublicData();
        return send(res, 200, { ok: true });
      }
    }
    if (body.type === "stream" && body.stream) {
      cur.streams = [body.stream, ...(cur.streams || [])]
        .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i)
        .slice(0, 40);
      writeJson(RANK_FILE, cur.streams);
      const finished = Boolean(body.stream.endedAt);
      // Local rankings every round; GitHub when the stream finishes.
      schedulePublicSync({
        forceRank: true,
        forceLive: finished,
        github: finished,
      });
      writeJson(LIVE_FILE, cur);
      if (finished) {
        // Publish promptly once — don't wait the long coalesce window.
        if (githubTimer) clearTimeout(githubTimer);
        githubTimer = null;
        flushGithubPublicData();
        return send(res, 200, { ok: true });
      }
    }
    if (body.type === "poll_init" && body.poll) {
      const id = body.poll.streamId;
      const existing = readJson(pollPath(id), null);
      const incoming = body.poll;
      const merged = mergePoll(existing, incoming);
      writeJson(pollPath(id), merged);
      schedulePublicSync({ pollId: id });
    }
    writeJson(LIVE_FILE, cur);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/rankings" && req.method === "GET") {
    const live = readJson(LIVE_FILE, { streams: [] });
    const file = readJson(RANK_FILE, []);
    return send(res, 200, live.streams?.length ? live.streams : file);
  }

  if (url.pathname === "/api/poll" && req.method === "GET") {
    const streamId = url.searchParams.get("streamId");
    if (!streamId) return send(res, 400, { error: "streamId required" });
    return send(
      res,
      200,
      readJson(pollPath(streamId), {
        streamId,
        options: [],
        votes: {},
        voters: {},
      })
    );
  }

  // Nightbot $(urlfetch) is GET-only — also keep POST for the web poll.
  if (
    url.pathname === "/api/poll/vote" &&
    (req.method === "GET" || req.method === "POST")
  ) {
    const wantText =
      url.searchParams.get("format") === "text" ||
      String(req.headers.accept || "").includes("text/plain");

    let streamId;
    let code;
    let voterId;
    let voterName;
    let avatarUrl = "";

    if (req.method === "GET") {
      streamId = url.searchParams.get("streamId") || "";
      code = url.searchParams.get("code") || url.searchParams.get("query") || "";
      voterName =
        url.searchParams.get("voter") ||
        url.searchParams.get("user") ||
        url.searchParams.get("displayName") ||
        "";
      voterId =
        url.searchParams.get("voterId") ||
        url.searchParams.get("userId") ||
        "";
      avatarUrl = url.searchParams.get("avatar") || "";
      const nbUser = parseNightbotUserHeader(req.headers["nightbot-user"]);
      if (nbUser) {
        if (!voterName) voterName = nbUser.displayName || nbUser.name || "";
        if (!voterId && nbUser.providerId) {
          voterId = `nb:${nbUser.provider || "yt"}:${nbUser.providerId}`;
        }
      }
      if (!voterId && voterName) voterId = `nb:${voterName}`;
    } else {
      const body = await parseBody(req);
      streamId = body.streamId || "";
      code = body.code || "";
      voterId = body.voterId || body.voter || "";
      voterName = body.voterName || body.voter || "";
      avatarUrl = body.avatarUrl || body.avatar || "";
    }

    // Nightbot $(query) is everything after !vote — accept code or full name.
    const queryRaw = String(code || "").trim();
    const resolved = resolveCountryQuery(queryRaw);
    code = resolved?.code || "";

    if (!streamId) {
      const live = readJson(LIVE_FILE, { live: null });
      streamId = live?.live?.streamId || "";
    }

    let result;
    if (!queryRaw) {
      result = { ok: false, status: 400, error: "usage" };
    } else if (!resolved) {
      result = { ok: false, status: 400, error: "unknown_country" };
    } else {
      result = applyPollVote({
        streamId,
        code,
        voterId,
        voterName,
        avatarUrl,
      });
    }
    if (wantText) {
      // Nightbot only posts the body when HTTP status is 2xx.
      // Non-200 shows as "Nightbot returned code XXX" in chat.
      return send(
        res,
        200,
        formatVoteText(result, voterName || voterId),
        "text/plain; charset=utf-8"
      );
    }
    if (!result.ok) {
      return send(res, result.status, { error: result.error });
    }
    return send(res, 200, {
      ...result.poll,
      voteCount: result.voteCount,
    });
  }

  if (url.pathname === "/api/predictions/config" && req.method === "GET") {
    const cfg = readJson(PRED_CONFIG_FILE, {});
    return send(res, 200, {
      googleClientId:
        process.env.GOOGLE_PREDICTIONS_CLIENT_ID ||
        process.env.GOOGLE_CLIENT_ID ||
        cfg.googleClientId ||
        "",
    });
  }

  if (url.pathname === "/api/predictions/meta" && req.method === "GET") {
    return send(res, 200, buildPredictionsMeta());
  }

  if (url.pathname === "/api/predictions" && req.method === "GET") {
    const store = readJson(PRED_FILE, { entries: [], updatedAt: null });
    const battleId = url.searchParams.get("battleId");
    if (battleId) {
      return send(res, 200, {
        ...store,
        entries: (store.entries || []).filter((e) => e.battleId === battleId),
      });
    }
    return send(res, 200, store);
  }

  if (url.pathname === "/api/predictions" && req.method === "POST") {
    const body = await parseBody(req);
    const entry = body.entry || {};
    const idToken = String(body.idToken || "");
    let userId = String(entry.userId || "");
    let name = String(entry.name || "Player");
    let email = String(entry.email || "");
    let picture = String(entry.picture || "");

    if (idToken) {
      try {
        const tres = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
        );
        if (tres.ok) {
          const info = await tres.json();
          if (info.sub) {
            userId = info.sub;
            name = info.name || info.given_name || name;
            email = info.email || email;
            picture = info.picture || picture;
          }
        }
      } catch {
        /* keep body identity */
      }
    }

    const battleId = String(entry.battleId || "").trim();
    const slots = Array.isArray(entry.slots)
      ? entry.slots
          .slice(0, 5)
          .map((c) =>
            String(c || "")
              .toLowerCase()
              .replace(/[^a-z]/g, "")
          )
      : [];
    if (!userId) return send(res, 401, { error: "Sign in required" });
    if (!battleId) return send(res, 400, { error: "battleId required" });
    if (slots.length !== 5 || slots.some((c) => !c) || new Set(slots).size !== 5) {
      return send(res, 400, { error: "Need 5 different country codes" });
    }

    // Selecting only before qualifying / after Final — not mid-battle.
    const liveFile = readJson(LIVE_FILE, { live: null, streams: [] });
    const liveSnap = liveFile.live || null;
    const streams = liveFile.streams?.length
      ? liveFile.streams
      : readJson(RANK_FILE, []);

    const phase = liveSnap?.phase || "";
    const battleLocked =
      liveSnap?.streamId &&
      phase &&
      phase !== "finished" &&
      phase !== "idle";

    if (battleLocked) {
      return send(res, 403, {
        error: "Predictions locked — wait until after the Final (or before the next battle)",
      });
    }

    if (battleId !== "upcoming") {
      const qual = streams.find((s) => s.id === battleId);
      if (qual?.endedAt && qual.mode !== "final") {
        return send(res, 403, {
          error: "Predictions locked — qualifying already ended for this battle",
        });
      }
      // Qualifying already started (rounds recorded) without being finished.
      if (
        qual &&
        !qual.endedAt &&
        Array.isArray(qual.rounds) &&
        qual.rounds.length > 0
      ) {
        return send(res, 403, {
          error: "Predictions locked — qualifying already started",
        });
      }
    }

    const saved = {
      userId,
      name,
      email,
      picture,
      battleId,
      slots,
      submittedAt: new Date().toISOString(),
      locked: Boolean(entry.locked),
    };
    const store = readJson(PRED_FILE, { entries: [] });
    const entries = Array.isArray(store.entries) ? store.entries : [];
    const idx = entries.findIndex(
      (e) => e.userId === userId && e.battleId === battleId
    );
    if (idx >= 0) entries[idx] = saved;
    else entries.unshift(saved);
    store.entries = entries.slice(0, 2000);
    store.updatedAt = new Date().toISOString();
    writeJson(PRED_FILE, store);
    schedulePublicSync({ forcePredictions: true, github: true });
    return send(res, 200, { ok: true, entry: saved });
  }

  if (url.pathname === "/api/announce" && req.method === "POST") {
    const body = await parseBody(req);
    const text = String(body.text || "")
      .replace(/[^\w\s.,!?'\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    if (!text) return send(res, 400, { error: "text required" });
    const now = Date.now();
    if (text === lastAnnounceText && now - lastAnnounceAt < 1500) {
      return send(res, 200, { ok: true, deduped: true });
    }
    lastAnnounceText = text;
    lastAnnounceAt = now;
    announceQueue = announceQueue
      .then(() => speakWithEspeak(text))
      .catch((err) => console.warn("[announce]", err.message || err));
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/channel" && req.method === "GET") {
    try {
      const channelId = url.searchParams.get("id") || process.env.YT_CHANNEL_ID;
      const force = url.searchParams.get("refresh") === "1";
      const cached = readJson(CHANNEL_CACHE, null);
      if (
        !force &&
        cached?.fetchedAt &&
        Date.now() - cached.fetchedAt < 60_000 &&
        (!channelId || cached.id === channelId)
      ) {
        return send(res, 200, cached);
      }
      const info = await fetchChannelStats(channelId);
      writeJson(CHANNEL_CACHE, info);
      return send(res, 200, info);
    } catch (err) {
      const cached = readJson(CHANNEL_CACHE, null);
      if (cached) return send(res, 200, { ...cached, stale: true });
      return send(res, 500, { error: String(err.message || err) });
    }
  }

  // Optional CORS proxy for Wikimedia Commons anthems (see data/anthems.json).
  // Shorts normally fetch Commons directly; this helps when a browser blocks it.
  if (url.pathname === "/api/anthem" && req.method === "GET") {
    const code = String(url.searchParams.get("code") || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (!code || code.length > 3) {
      return send(res, 400, { error: "valid ISO country code required" });
    }
    try {
      const map = readJson(path.join(PUBLIC_DATA, "anthems.json"), { urls: {} });
      const upstream = map.urls?.[code];
      if (!upstream) {
        return send(res, 404, { error: `anthem not mapped for ${code}` });
      }
      const upstreamRes = await fetch(upstream, {
        headers: {
          Accept: "audio/*,application/ogg,*/*",
          "User-Agent": "FlagBattle/1.0 (anthem proxy)",
        },
      });
      if (!upstreamRes.ok) {
        return send(res, upstreamRes.status, {
          error: `upstream anthem failed for ${code}`,
        });
      }
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      const ct = upstreamRes.headers.get("content-type") || "application/ogg";
      res.writeHead(200, {
        "Content-Type": ct,
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
      });
      res.end(buf);
      return;
    } catch (err) {
      return send(res, 502, { error: String(err.message || err) });
    }
  }

  return send(res, 404, { error: "not found" });
}

function whichBin(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    try {
      fs.accessSync(path.join(d, name), fs.constants.X_OK);
      return path.join(d, name);
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Speak via espeak into PulseAudio (captured by FFmpeg during go-live). */
function speakWithEspeak(text) {
  const espeak = whichBin("espeak-ng") || whichBin("espeak");
  if (!espeak) return Promise.resolve(false);
  const wav = path.join(DATA, `announce-${Date.now()}.wav`);
  return new Promise((resolve) => {
    const voice = spawn(
      espeak,
      ["-v", "en+m3", "-s", "145", "-w", wav, text],
      { stdio: "ignore" }
    );
    voice.on("exit", (code) => {
      if (code !== 0 || !fs.existsSync(wav)) return resolve(false);
      const play =
        whichBin("paplay") || whichBin("aplay") || whichBin("ffplay");
      if (!play) {
        try {
          fs.unlinkSync(wav);
        } catch {
          /* ignore */
        }
        return resolve(false);
      }
      const args =
        path.basename(play) === "ffplay"
          ? ["-nodisp", "-autoexit", "-loglevel", "error", wav]
          : [wav];
      const player = spawn(play, args, {
        stdio: "ignore",
        env: { ...process.env },
      });
      player.on("exit", () => {
        try {
          fs.unlinkSync(wav);
        } catch {
          /* ignore */
        }
        resolve(true);
      });
      player.on("error", () => resolve(false));
    });
    voice.on("error", () => resolve(false));
  });
}

async function fetchChannelStats(channelId) {
  const apiKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY;
  let url;
  const headers = {};

  if (channelId && apiKey) {
    url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelId)}&key=${apiKey}`;
  } else if (apiKey && process.env.YT_CHANNEL_HANDLE) {
    const handle = process.env.YT_CHANNEL_HANDLE.replace(/^@/, "");
    url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;
  } else {
    // OAuth: authenticated channel (the livestream account).
    const token = await getAccessToken();
    url =
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true";
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || JSON.stringify(data.error || data));
  }
  const item = data.items?.[0];
  if (!item) throw new Error("No channel found");

  return {
    id: item.id,
    title: item.snippet?.title || "Channel",
    customUrl: item.snippet?.customUrl || "",
    subscriberCount: Number(item.statistics?.subscriberCount || 0),
    hiddenSubscriberCount: !!item.statistics?.hiddenSubscriberCount,
    thumbnail: item.snippet?.thumbnails?.default?.url || "",
    fetchedAt: Date.now(),
  };
}

async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Set GOOGLE_* OAuth in stream/.env, or YOUTUBE_API_KEY + YT_CHANNEL_ID"
    );
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "token refresh failed");
  }
  return data.access_token;
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "Not found", "text/plain");
  }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FLAG BATTLE server http://localhost:${PORT}`);
  console.log(`Rankings: /rankings.html   Poll: /poll.html`);
  console.log(
    `GitHub Pages sync: ${githubSyncEnabled() ? "enabled" : "off (no token)"}`
  );
  if (publicApi) console.log(`Public API: ${publicApi}`);
});

process.on("SIGTERM", () => {
  flushPublicSync();
});
process.on("SIGINT", () => {
  flushPublicSync();
});
