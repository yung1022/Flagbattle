/**
 * Static site + tiny API for rankings / live poll / channel stats.
 *   node server.mjs
 *   PORT=5173 node server.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const DATA = path.join(ROOT, ".data");
const LIVE_FILE = path.join(DATA, "live.json");
const RANK_FILE = path.join(DATA, "rankings.json");
const POLL_DIR = path.join(DATA, "polls");
const CHANNEL_CACHE = path.join(DATA, "channel.json");

fs.mkdirSync(POLL_DIR, { recursive: true });
loadEnvFile(path.join(ROOT, "stream/.env"));
loadEnvFile(path.join(ROOT, ".env"));

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

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/api/live" && req.method === "GET") {
    return send(res, 200, readJson(LIVE_FILE, { live: null, streams: [] }));
  }

  if (url.pathname === "/api/live" && req.method === "POST") {
    const body = await parseBody(req);
    const cur = readJson(LIVE_FILE, { live: null, streams: [] });
    if (body.type === "live") {
      cur.live = body.live;
      // Seed poll options from qualified list when present.
      if (body.live?.streamId && body.live?.qualified?.length) {
        const existing = readJson(pollPath(body.live.streamId), null);
        if (!existing?.options?.length) {
          writeJson(pollPath(body.live.streamId), {
            streamId: body.live.streamId,
            options: body.live.qualified,
            votes: Object.fromEntries(
              body.live.qualified.map((q) => [q.code, 0])
            ),
            voters: {},
            updatedAt: Date.now(),
          });
        }
      }
    }
    if (body.type === "stream" && body.stream) {
      cur.streams = [body.stream, ...(cur.streams || [])]
        .filter(
          (s, i, arr) => arr.findIndex((x) => x.id === s.id) === i
        )
        .slice(0, 40);
      writeJson(RANK_FILE, cur.streams);
    }
    if (body.type === "poll_init" && body.poll) {
      writeJson(pollPath(body.poll.streamId), body.poll);
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

  if (url.pathname === "/api/poll/vote" && req.method === "POST") {
    const body = await parseBody(req);
    const { streamId, code, voterId } = body;
    if (!streamId || !code || !voterId) {
      return send(res, 400, { error: "streamId, code, voterId required" });
    }
    const poll = readJson(pollPath(streamId), {
      streamId,
      options: [],
      votes: {},
      voters: {},
    });
    const prev = poll.voters[voterId];
    if (prev && poll.votes[prev] > 0) poll.votes[prev] -= 1;
    poll.voters[voterId] = code;
    poll.votes[code] = (poll.votes[code] || 0) + 1;
    poll.updatedAt = Date.now();
    writeJson(pollPath(streamId), poll);
    return send(res, 200, poll);
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

  return send(res, 404, { error: "not found" });
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
});
