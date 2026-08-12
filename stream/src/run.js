/**
 * FLAG BATTLE auto-stream
 * Creates a YouTube Live broadcast and pushes the 9:16 arena via FFmpeg
 * (Xvfb + Chrome) — no OBS / streaming software required.
 *
 * Usage:
 *   npm run go-live --prefix stream
 *   npm run go-live:demo --prefix stream
 *   node stream/src/run.js --demo 90 --privacy unlisted
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.js";
import {
  createLiveBroadcast,
  goLive,
  completeBroadcast,
  ensureVideoThumbnail,
  postLiveChatMessage,
  applyVideoDiscovery,
  DEFAULT_LIVE_TAGS,
  DEFAULT_LIVE_KEYWORDS,
} from "./youtube.js";
import { startChatVoteLoop } from "./chat-vote.js";
import { syncNightbotVoteCommand, nightbotVoteMessage } from "./nightbot.js";
import { startYoutubePollOrchestrator } from "./yt-polls.js";
import { buildNextLiveTitle } from "./live-title.js";
import { prepareNcsBed } from "./ncs-music.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
// Prefer the compressed YouTube JPEG (<2MB); resolver also falls back to PNG.
const THUMB = path.join(ROOT, "assets/thumbnail-yt.jpg");
const PUBLIC_SITE_DEFAULT = "https://yung1022.github.io/Flagbattle";
const WENT_LIVE_MARKER = path.join(ROOT, ".data", "went-live");
/** Exit code: failed before YouTube transitioned to live — workflow may re-dispatch. */
const EXIT_PRE_LIVE_FAIL = 75;
let pulseSink = null;
let wentLive = false;
/** @type {string | null} */
let ncsBedPath = null;

const args = parseArgs(process.argv.slice(2));
const WIDTH = Number(process.env.STREAM_WIDTH || 1080);
const HEIGHT = Number(process.env.STREAM_HEIGHT || 1920);
const FPS = Number(process.env.STREAM_FPS || 30);
const PORT = Number(process.env.GAME_PORT || 5173);
const DEMO = args.demo ?? process.env.DEMO_SECONDS;
const PRIVACY = args.privacy || process.env.YT_PRIVACY || "public";
const MODE = normalizeMode(args.mode || process.env.STREAM_MODE || "qualifying");
const liveTitle = buildNextLiveTitle({ root: ROOT });
const TITLE =
  args.title ||
  process.env.YT_TITLE ||
  liveTitle.title;
const DESCRIPTION_BASE =
  process.env.YT_DESCRIPTION ||
  "FLAG BATTLE livestream (~4 hours). Opening (type a country to spawn = vote) → Main (last standing = +1 point, random events) → Alien Invasion (most Main points wins) — all in one stream.\n\nVote / spawn: type a country name, or !vote Japan / !vote jp. Every 5 votes grows your flag. Poll & rankings: https://yung1022.github.io/Flagbattle/";
let DESCRIPTION = DESCRIPTION_BASE;

const children = [];
let display = null;
let youtubeClient = null;
let broadcastId = null;
let shuttingDown = false;
let chatAbort = null;

async function main() {
  // Fresh marker each attempt — workflow only re-dispatches when this stays missing.
  try {
    fs.rmSync(WENT_LIVE_MARKER, { force: true });
  } catch {
    /* ignore */
  }

  console.log("▶ FLAG BATTLE auto-stream");
  if (!args.title && !process.env.YT_TITLE) {
    console.log(
      `Title: ${TITLE} (${liveTitle.dateLabel} · #${liveTitle.streamNumber} · ${liveTitle.timeZone})`
    );
  } else {
    console.log(`Title: ${TITLE}`);
  }
  assertBinaries();

  const ncs = await prepareNcsBed({ pages: 2 });
  if (ncs.ok && ncs.path) {
    ncsBedPath = ncs.path;
    DESCRIPTION = `${DESCRIPTION_BASE}\n\n———\n${ncs.credit}`;
    console.log(`[ncs] Using NCS ambient bed: ${ncs.song?.name || ncs.path}`);
  } else {
    console.warn(`[ncs] Falling back to synth bed: ${ncs.error || "unknown"}`);
  }

  pulseSink = await startPulseAudio();
  if (pulseSink) {
    process.env.PULSE_SINK = pulseSink;
    process.env.PULSE_SOURCE = `${pulseSink}.monitor`;
    console.log(`PulseAudio sink: ${pulseSink}`);
  }

  await startGameServer(PORT);
  const tunnelUrl = await startPublicTunnel(PORT);
  if (tunnelUrl) {
    process.env.PUBLIC_API = tunnelUrl;
    await registerPublicApi(PORT, tunnelUrl);
    console.log(`Public API tunnel: ${tunnelUrl}`);
  } else {
    console.warn(
      "No public tunnel — poll votes need PUBLIC_API or cloudflared"
    );
  }
  console.log(`Stream mode: ${MODE}`);
  const gameUrl = buildGameUrl(PORT, DEMO, tunnelUrl, MODE);
  console.log(`Game: ${gameUrl}`);
  console.log(`Rankings/poll API on :${PORT}`);

  const liveTags = parseTags(process.env.YT_TAGS) || DEFAULT_LIVE_TAGS;
  const liveKeywords =
    parseTags(process.env.YT_KEYWORDS) || DEFAULT_LIVE_KEYWORDS;
  const live = await createLiveBroadcast({
    title: TITLE,
    description: DESCRIPTION,
    privacyStatus: PRIVACY,
    thumbnailPath: THUMB,
    tags: liveTags,
    keywords: liveKeywords,
    categoryId: process.env.YT_CATEGORY_ID || "20",
  });
  youtubeClient = live.youtube;
  broadcastId = live.broadcastId;
  console.log(`YouTube watch: ${live.watchUrl}`);
  console.log(
    `Discovery: ${liveTags.length} tags, ${liveKeywords.length} keywords`
  );
  console.log(`RTMP ingest ready`);

  display = await findFreeDisplay();
  await startXvfb(display, WIDTH, HEIGHT);
  await sleep(800);
  await startChrome(display, gameUrl, WIDTH, HEIGHT);
  await sleep(3500);

  const ffmpeg = startFfmpeg(display, live.rtmpUrl, WIDTH, HEIGHT, FPS);
  children.push(ffmpeg);

  // Give YouTube a moment to detect the ingest, then go live.
  await sleep(12_000);
  await goLive(youtubeClient, broadcastId);
  markWentLive();

  // Only retry thumbnail if the pre-live set failed (double-upload was
  // hitting YouTube's "too many thumbnails recently" quota).
  await ensureVideoThumbnail(youtubeClient, broadcastId, THUMB, {
    alreadySet: Boolean(live.thumbnailSet),
    retries: 3,
    baseDelayMs: 45_000,
    initialDelayMs: live.thumbnailSet ? 0 : 30_000,
  });

  // Re-apply tags/keywords after live — more reliable than pre-live only.
  try {
    await applyVideoDiscovery(youtubeClient, broadcastId, {
      title: TITLE,
      description: DESCRIPTION,
      tags: liveTags,
      keywords: liveKeywords,
      categoryId: process.env.YT_CATEGORY_ID || "20",
    });
  } catch (err) {
    console.warn("Post-live tags/keywords failed:", err.message || err);
  }

  await postChatLinks(youtubeClient, broadcastId, tunnelUrl, MODE);

  // Nightbot owns !vote as a backup. Bare country names use the chat listener below.
  const apiBase = tunnelUrl || `http://127.0.0.1:${PORT}`;
  const nightbot = await syncNightbotVoteCommand(apiBase);
  if (nightbot.ok) {
    console.log("[nightbot] !vote command synced to tunnel");
  } else if (nightbot.error && nightbot.error !== "NIGHTBOT_TOKEN not set") {
    console.warn("[nightbot] sync failed:", nightbot.error);
  } else {
    console.log(
      "[nightbot] Set NIGHTBOT_TOKEN to auto-update !vote, or add manually:"
    );
    console.log(`  ${nightbotVoteMessage(apiBase)}`);
  }

  // Bare country-name votes need a chat listener (Nightbot cannot match
  // arbitrary country names with one command). Default ON via Innertube
  // (no Data API list quota). CHAT_VOTE=0 disables; CHAT_VOTE_SOURCE=api
  // forces the old quota-burning liveChatMessages.list path.
  if (String(process.env.CHAT_VOTE || "1").trim() !== "0") {
    chatAbort = new AbortController();
    startChatVoteLoop({
      youtube: youtubeClient,
      broadcastId,
      apiBase,
      signal: chatAbort.signal,
      getStreamId: () => readLiveStreamId(PORT),
    }).catch((err) => console.warn("[chat-vote] stopped:", err.message || err));
    const src = String(process.env.CHAT_VOTE_SOURCE || "innertube")
      .trim()
      .toLowerCase();
    console.log(
      `[chat-vote] Listening for !vote and bare country names via ${src} (CHAT_VOTE=0 to disable)`
    );
  } else {
    console.log("[chat-vote] Off (CHAT_VOTE=0) — Nightbot !vote only");
  }

  // Pinned Live Chat polls: community poll winner → Final 4 (one active at a time).
  if (String(process.env.YT_LIVE_POLLS || "1").trim() !== "0") {
    if (!chatAbort) chatAbort = new AbortController();
    startYoutubePollOrchestrator({
      youtube: youtubeClient,
      broadcastId,
      port: PORT,
      mode: MODE,
      signal: chatAbort.signal,
    }).catch((err) => console.warn("[yt-polls] stopped:", err.message || err));
  } else {
    console.log("[yt-polls] Disabled (YT_LIVE_POLLS=0)");
  }

  console.log(`\n🔴 LIVE (${MODE}) — press Ctrl+C to end the stream\n`);
  console.log(live.watchUrl);

  const ffmpegDone = new Promise((resolve) => {
    ffmpeg.on("exit", (code) => {
      console.log(`ffmpeg exited (${code})`);
      resolve("ffmpeg");
    });
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // Full battle (Qual → Final in one broadcast): stay live until champion hold ends.
  const reason = await Promise.race([
    waitForFinalStreamComplete(PORT),
    ffmpegDone,
  ]);
  console.log(`Stream stop reason: ${reason}`);
  await shutdown(0);
}

/**
 * Poll local live API until Final has a winner and the champion hold ended
 * (stream.endedAt / status finished). Never end during winner_hold.
 */
async function waitForFinalStreamComplete(port) {
  console.log(
    "[stream] Waiting for champion + 1-minute winner hold before ending…"
  );
  let sawWinner = false;
  let winnerSeenAt = 0;
  const holdFloorMs = Number(process.env.WINNER_HOLD_MS || 60_000);
  for (;;) {
    if (shuttingDown) return "shutdown";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/live`);
      const data = res.ok ? await res.json() : null;
      const live = data?.live;
      const holding =
        live?.streamStatus === "winner_hold" ||
        (Number(live?.winnerHoldRemainingMs) || 0) > 0;

      if (live?.winner || live?.phase === "finished") {
        if (!sawWinner) {
          sawWinner = true;
          winnerSeenAt = Date.now();
          console.log(
            `[stream] Champion ${live.winner?.name || "?"} — holding ${Math.round(holdFloorMs / 1000)}s before end`
          );
        }
      }

      // Still on the winner screen — keep streaming.
      if (holding) {
        await sleep(3000);
        continue;
      }

      // Game sets endedAt only after the 1-minute winner hold.
      const holdElapsed = sawWinner ? Date.now() - winnerSeenAt : 0;
      if (
        sawWinner &&
        live?.phase === "finished" &&
        live?.winner &&
        live?.endedAt &&
        live?.streamStatus === "finished" &&
        holdElapsed >= Math.max(5_000, holdFloorMs - 2_000)
      ) {
        console.log("[stream] Winner hold complete — ending livestream");
        // Brief encode buffer so the last champion frames land in the VOD.
        await sleep(3000);
        return "winner_hold_done";
      }

      // Also watch rankings streams list for this live id (post-hold only).
      const streams = data?.streams || [];
      const sid = live?.streamId;
      const row = sid && streams.find((s) => s.id === sid);
      if (
        sawWinner &&
        !holding &&
        row?.endedAt &&
        row?.winner &&
        holdElapsed >= Math.max(5_000, holdFloorMs - 2_000)
      ) {
        console.log("[stream] Final stream marked ended — shutting down");
        await sleep(3000);
        return "stream_ended";
      }
    } catch {
      /* server blip */
    }
    await sleep(3000);
  }
}

async function postChatLinks(youtube, id, apiUrl, mode = "qualifying") {
  const site = (
    process.env.PUBLIC_SITE ||
    process.env.SITE_URL ||
    PUBLIC_SITE_DEFAULT
  ).replace(/\/$/, "");
  const poll = `${site}/poll.html`;
  const rank = `${site}/rankings.html`;

  // One combined instructions message (YouTube live chat ~200 char limit).
  const line =
    `Vote/spawn: type Japan or !vote jp (flag may take ~30s). ` +
    `Poll: ${poll} · Rankings: ${rank}`;
  void mode;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await postLiveChatMessage(youtube, id, line.slice(0, 200));
      break;
    } catch (err) {
      console.warn(`Chat post retry ${attempt + 1}:`, err.message || err);
      await sleep(4000);
    }
  }
}

function readLiveStreamId(port) {
  // Synchronous-ish via last cached value updated by async poller.
  return cachedLiveStreamId;
}

let cachedLiveStreamId = null;
setInterval(() => {
  fetch(`http://127.0.0.1:${PORT}/api/live`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const id = data?.live?.streamId || null;
      if (id) cachedLiveStreamId = id;
    })
    .catch(() => {});
}, 4000);

/** Null-sink so Chrome/espeak audio can be muxed into the YouTube stream. */
function startPulseAudio() {
  return new Promise((resolve) => {
    const pulse = whichBin("pulseaudio");
    const pactl = whichBin("pactl");
    if (!pulse || !pactl) {
      console.warn("PulseAudio not found — stream audio will be silent bed only");
      return resolve(null);
    }
    const sinkName = "flagbattle";
    const boot = spawn(pulse, ["--start", "--exit-idle-time=-1"], {
      stdio: "ignore",
    });
    boot.on("exit", () => {
      spawn(pactl, ["load-module", "module-null-sink", `sink_name=${sinkName}`, "sink_properties=device.description=FlagBattle"], {
        stdio: "ignore",
      }).on("exit", (code) => {
        if (code !== 0) {
          // Sink may already exist from a prior run.
          console.warn("Pulse null-sink load returned", code, "(continuing)");
        }
        const finish = () => {
          // Unmute + full volume so Web Audio ambient reaches FFmpeg.
          spawn(pactl, ["set-sink-mute", sinkName, "0"], { stdio: "ignore" });
          spawn(pactl, ["set-sink-volume", sinkName, "100%"], { stdio: "ignore" });
          spawn(pactl, ["set-default-sink", sinkName], { stdio: "ignore" }).on(
            "exit",
            () => resolve(sinkName)
          );
        };
        finish();
      });
    });
    boot.on("error", () => resolve(null));
    setTimeout(() => resolve(sinkName), 2500);
  });
}

function buildGameUrl(port, demo, apiUrl, mode = "qualifying") {
  const qs = new URLSearchParams({
    stream: "1",
    autostart: "1",
    mode: normalizeMode(mode),
  });
  if (demo != null && demo !== "") qs.set("demo", String(demo));
  // Public site for poll/rankings (posted to live chat; no on-screen QR).
  const site = (
    process.env.PUBLIC_SITE ||
    process.env.SITE_URL ||
    process.env.FLAGBATTLE_SITE ||
    PUBLIC_SITE_DEFAULT
  ).replace(/\/$/, "");
  qs.set("site", site);
  const api = (
    apiUrl ||
    process.env.PUBLIC_API ||
    process.env.PUBLIC_API_URL ||
    ""
  ).replace(/\/$/, "");
  if (api) qs.set("api", api);
  return `http://127.0.0.1:${port}/?${qs.toString()}`;
}

function normalizeMode(mode) {
  return String(mode || "").toLowerCase() === "final" ? "final" : "qualifying";
}

async function registerPublicApi(port, apiUrl) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: apiUrl }),
    });
  } catch (err) {
    console.warn("Could not register PUBLIC_API on server:", err.message || err);
  }
}

/** Expose local API via Cloudflare quick tunnel for GitHub Pages voters. */
function startPublicTunnel(port) {
  const disabled =
    process.env.DISABLE_TUNNEL === "1" || process.env.DISABLE_TUNNEL === "true";
  if (disabled) return Promise.resolve(null);
  if (process.env.PUBLIC_API || process.env.PUBLIC_API_URL) {
    return Promise.resolve(
      (process.env.PUBLIC_API || process.env.PUBLIC_API_URL).replace(/\/$/, "")
    );
  }

  const bin = whichBin("cloudflared");
  if (!bin) {
    console.warn("cloudflared not found — install it for public poll voting");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const proc = spawn(
      bin,
      ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    children.push(proc);
    let settled = false;
    const done = (url) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    const onChunk = (buf) => {
      const text = buf.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) done(match[0]);
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    proc.on("error", () => done(null));
    proc.on("exit", () => done(null));
    setTimeout(() => done(null), 25_000);
  });
}

function whichBin(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* continue */
    }
  }
  return null;
}

function startGameServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(proc);
    let ready = false;
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      if (!ready && text.includes("FLAG BATTLE server")) {
        ready = true;
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (!ready) reject(new Error(`server.mjs exited early (${code})`));
    });
    setTimeout(() => {
      if (!ready) {
        ready = true;
        resolve(proc);
      }
    }, 2000);
  });
}

function assertBinaries() {
  for (const bin of ["ffmpeg", "Xvfb", "google-chrome"]) {
    try {
      spawn(bin === "google-chrome" ? "google-chrome" : bin, ["-version"], {
        stdio: "ignore",
      });
    } catch {
      // spawn itself rarely throws; existence checked below
    }
  }
  const which = (name) => {
    const dirs = (process.env.PATH || "").split(path.delimiter);
    return dirs.some((d) => {
      try {
        fs.accessSync(path.join(d, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  };
  for (const bin of ["ffmpeg", "Xvfb"]) {
    if (!which(bin)) {
      throw new Error(`Missing required binary: ${bin}`);
    }
  }
  if (!which("google-chrome") && !which("google-chrome-stable") && !which("chromium")) {
    throw new Error("Missing Chrome/Chromium");
  }
}

function chromeBin() {
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const dirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of dirs) {
      const p = path.join(d, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* continue */
      }
    }
  }
  return "google-chrome";
}

async function findFreeDisplay() {
  for (let n = 90; n < 120; n++) {
    const lock = `/tmp/.X${n}-lock`;
    if (!fs.existsSync(lock)) return `:${n}`;
  }
  return ":99";
}

function startXvfb(displayNum, w, h) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "Xvfb",
      [displayNum, "-screen", "0", `${w}x${h}x24`, "-ac", "+extension", "RANDR"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    children.push(proc);
    let settled = false;
    const ok = () => {
      if (!settled) {
        settled = true;
        console.log(`Xvfb ${displayNum} ${w}x${h}`);
        resolve();
      }
    };
    proc.stderr.on("data", () => ok());
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`Xvfb exited early (${code})`));
    });
    setTimeout(ok, 600);
  });
}

function parseTags(raw) {
  if (!raw || !String(raw).trim()) return undefined;
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function startChrome(displayNum, url, w, h) {
  const userData = fs.mkdtempSync(path.join("/tmp", "flagbattle-chrome-"));
  const proc = spawn(
    chromeBin(),
    [
      `--display=${displayNum}`,
      `--window-size=${w},${h}`,
      "--window-position=0,0",
      "--kiosk",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      // Keep Web Audio / ambient music outputting to Pulse (not sandboxed out).
      "--disable-features=TranslateUI,PaintHolding,AudioServiceOutOfProcess,AudioServiceSandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-media-suspend",
      "--no-sandbox",
      // Prefer SwiftShader compositing over fully disabling GPU (smoother layers).
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-features=CanvasOopRasterization",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-ipc-flooding-protection",
      "--memory-pressure-off",
      `--user-data-dir=${userData}`,
      url,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        DISPLAY: displayNum,
        ...(process.env.PULSE_SINK ? { PULSE_SINK: process.env.PULSE_SINK } : {}),
        ...(process.env.PULSE_SOURCE
          ? { PULSE_SOURCE: process.env.PULSE_SOURCE }
          : {}),
      },
    }
  );
  children.push(proc);
  console.log("Chrome launched on virtual display");
  return proc;
}

function startFfmpeg(displayNum, rtmpUrl, w, h, fps) {
  // Bitrate scales with resolution so 720p runners stay real-time.
  const pixels = w * h;
  const bitrate =
    process.env.STREAM_BITRATE ||
    (pixels >= 1080 * 1920 ? "4500k" : pixels >= 720 * 1280 ? "2500k" : "1800k");
  const maxrate =
    process.env.STREAM_MAXRATE ||
    (String(bitrate).endsWith("k")
      ? `${Math.round(Number(String(bitrate).slice(0, -1)) * 1.15)}k`
      : bitrate);
  const bufsize =
    process.env.STREAM_BUFSIZE ||
    (String(bitrate).endsWith("k")
      ? `${Math.round(Number(String(bitrate).slice(0, -1)) * 2)}k`
      : "4000k");
  const preset = process.env.STREAM_PRESET || "ultrafast";

  const usePulse = Boolean(process.env.PULSE_SOURCE || process.env.PULSE_SINK);
  const pulseSource =
    process.env.PULSE_SOURCE ||
    (process.env.PULSE_SINK ? `${process.env.PULSE_SINK}.monitor` : "");

  // NCS MP3 bed (looped) when available; otherwise soft lavfi pad.
  const useNcs = Boolean(ncsBedPath && fs.existsSync(ncsBedPath));
  const synthBed =
    "aevalsrc=exprs=" +
    "0.055*sin(2*PI*110*t)+0.035*sin(2*PI*164.81*t)+0.022*sin(2*PI*220*t)+" +
    "0.012*sin(2*PI*329.63*t)" +
    ":s=44100:c=stereo,lowpass=f=900,volume=0.9";

  // Video from X11; audio = Pulse (Chrome SFX/TTS) + always-on ambient bed.
  const args = [
    "-y",
    "-thread_queue_size",
    "512",
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-framerate",
    String(fps),
    "-video_size",
    `${w}x${h}`,
    "-i",
    `${displayNum}.0`,
  ];

  const pushBedInput = () => {
    if (useNcs) {
      args.push(
        "-stream_loop",
        "-1",
        "-thread_queue_size",
        "512",
        "-i",
        ncsBedPath
      );
    } else {
      args.push("-f", "lavfi", "-thread_queue_size", "512", "-i", synthBed);
    }
  };

  if (usePulse && pulseSource) {
    args.push(
      "-thread_queue_size",
      "512",
      "-f",
      "pulse",
      "-i",
      pulseSource
    );
    pushBedInput();
    const bedVol = useNcs ? "0.28" : "0.55";
    args.push(
      "-filter_complex",
      "[1:a]aresample=async=1:first_pts=0,volume=1.55[pulse];" +
        `[2:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${bedVol}[bed];` +
        "[pulse][bed]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]",
      "-map",
      "0:v",
      "-map",
      "[aout]"
    );
  } else {
    pushBedInput();
    args.push("-map", "0:v", "-map", "1:a");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps * 2),
    "-keyint_min",
    String(fps),
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-b:v",
    bitrate,
    "-maxrate",
    maxrate,
    "-bufsize",
    bufsize,
    "-fps_mode",
    "cfr",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "44100",
    "-shortest",
    "-f",
    "flv",
    rtmpUrl
  );

  console.log(
    `FFmpeg → YouTube RTMP (${w}x${h}@${fps} ${preset} ${bitrate}${
      usePulse ? " +pulse" : ""
    }${useNcs ? "+ncs" : "+synth"})`
  );
  const proc = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DISPLAY: displayNum },
  });
  proc.stderr.on("data", (buf) => {
    const line = buf.toString();
    if (line.includes("frame=") || line.includes("Error") || line.includes("error")) {
      process.stdout.write(line.includes("frame=") ? `\r${line.trim()}` : line);
    }
  });
  return proc;
}

function markWentLive() {
  wentLive = true;
  try {
    fs.mkdirSync(path.dirname(WENT_LIVE_MARKER), { recursive: true });
    fs.writeFileSync(
      WENT_LIVE_MARKER,
      `${new Date().toISOString()}\nbroadcast=${broadcastId || ""}\n`
    );
    console.log(`[stream] Went live — wrote ${WENT_LIVE_MARKER}`);
  } catch (err) {
    console.warn("[stream] Could not write went-live marker:", err?.message || err);
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
  try {
    chatAbort?.abort();
  } catch {
    /* ignore */
  }
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (youtubeClient && broadcastId) {
    await completeBroadcast(youtubeClient, broadcastId);
  }
  // Pre-live failures use EXIT_PRE_LIVE_FAIL so the workflow can re-dispatch.
  const exitCode =
    code !== 0 && !wentLive ? EXIT_PRE_LIVE_FAIL : code;
  if (exitCode === EXIT_PRE_LIVE_FAIL) {
    console.error(
      `[stream] Failed before going live (exit ${EXIT_PRE_LIVE_FAIL}) — job may auto-rerun`
    );
  }
  setTimeout(() => process.exit(exitCode), 1500);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--demo") out.demo = argv[++i];
    else if (a.startsWith("--demo=")) out.demo = a.slice(7);
    else if (a === "--privacy") out.privacy = argv[++i];
    else if (a.startsWith("--privacy=")) out.privacy = a.slice(10);
    else if (a === "--title") out.title = argv[++i];
    else if (a.startsWith("--title=")) out.title = a.slice(8);
    else if (a === "--mode") out.mode = argv[++i];
    else if (a.startsWith("--mode=")) out.mode = a.slice(7);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(async (err) => {
  console.error(err);
  await shutdown(1);
});
