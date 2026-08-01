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
} from "./youtube.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const THUMB = path.join(ROOT, "assets/thumbnail.png");

const args = parseArgs(process.argv.slice(2));
const WIDTH = Number(process.env.STREAM_WIDTH || 1080);
const HEIGHT = Number(process.env.STREAM_HEIGHT || 1920);
const FPS = Number(process.env.STREAM_FPS || 30);
const PORT = Number(process.env.GAME_PORT || 5173);
const DEMO = args.demo ?? process.env.DEMO_SECONDS;
const PRIVACY = args.privacy || process.env.YT_PRIVACY || "public";
const TITLE =
  args.title ||
  process.env.YT_TITLE ||
  "FLAG BATTLE — Last Flag Standing (Live)";
const DESCRIPTION =
  process.env.YT_DESCRIPTION ||
  "All-country FLAG BATTLE livestream. Qualifying rounds: last flag in the circle qualifies. Then Last Flag Standing final. Stay inside the ring — fall through the hole and you're out.\n\nPoll & rankings: https://yung1022.github.io/Flagbattle/";

const children = [];
let display = null;
let youtubeClient = null;
let broadcastId = null;
let shuttingDown = false;

async function main() {
  console.log("▶ FLAG BATTLE auto-stream");
  assertBinaries();

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
  const gameUrl = buildGameUrl(PORT, DEMO, tunnelUrl);
  console.log(`Game: ${gameUrl}`);
  console.log(`Rankings/poll API on :${PORT}`);

  const live = await createLiveBroadcast({
    title: TITLE,
    description: DESCRIPTION,
    privacyStatus: PRIVACY,
    thumbnailPath: THUMB,
  });
  youtubeClient = live.youtube;
  broadcastId = live.broadcastId;
  console.log(`YouTube watch: ${live.watchUrl}`);
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

  console.log("\n🔴 LIVE — press Ctrl+C to end the stream\n");
  console.log(live.watchUrl);

  const done = new Promise((resolve) => {
    ffmpeg.on("exit", (code) => {
      console.log(`ffmpeg exited (${code})`);
      resolve();
    });
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  await done;
  await shutdown(0);
}

const DEFAULT_PUBLIC_SITE = "https://yung1022.github.io/Flagbattle";

function buildGameUrl(port, demo, apiUrl) {
  const qs = new URLSearchParams({ stream: "1", autostart: "1" });
  if (demo != null && demo !== "") qs.set("demo", String(demo));
  // Public site URL printed as QR/links on the livestream overlay.
  const site = (
    process.env.PUBLIC_SITE ||
    process.env.SITE_URL ||
    process.env.FLAGBATTLE_SITE ||
    DEFAULT_PUBLIC_SITE
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
      "--disable-features=TranslateUI",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      url,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, DISPLAY: displayNum },
    }
  );
  children.push(proc);
  console.log("Chrome launched on virtual display");
  return proc;
}

function startFfmpeg(displayNum, rtmpUrl, w, h, fps) {
  // Silent AAC bed — YouTube requires an audio track.
  const args = [
    "-y",
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
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps * 2),
    "-b:v",
    "4500k",
    "-maxrate",
    "5000k",
    "-bufsize",
    "10000k",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-f",
    "flv",
    rtmpUrl,
  ];

  console.log("FFmpeg → YouTube RTMP");
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

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
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
  setTimeout(() => process.exit(code), 1500);
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
