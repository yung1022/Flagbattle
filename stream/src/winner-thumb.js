/**
 * Build / upload a winner thumbnail and update the livestream title.
 *
 * Start thumb (`assets/thumbnail-yt-1280.jpg`) has a blank white center flag.
 * When a champion is crowned we overlay their flag + "{Country} Wins" and
 * push title/thumbnail to YouTube.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyVideoDiscovery, setVideoThumbnail } from "./youtube.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/** Blank white flag cloth slot on the 1280×720 landscape thumb. */
const FLAG_SLOT = { x: 515, y: 290, w: 280, h: 210 };

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
];

/**
 * @param {string} baseTitle
 * @param {string} countryName
 */
export function withWinnerTitle(baseTitle, countryName) {
  const name = String(countryName || "Winner").trim() || "Winner";
  const suffix = ` · ${name} Wins`;
  const base = String(baseTitle || "FLAG BATTLE").trim() || "FLAG BATTLE";
  // Drop a previous " · X Wins" if re-applied.
  const cleaned = base.replace(/\s*[·\-–—]\s*[^·\-–—]+?\s+Wins\s*$/i, "").trim();
  const room = Math.max(10, 100 - suffix.length);
  return `${cleaned.slice(0, room)}${suffix}`.slice(0, 100);
}

function resolveFont() {
  for (const f of FONT_CANDIDATES) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function escapeDrawtext(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "%%");
}

/**
 * Download a country flag PNG (flagcdn).
 * @param {string} code
 * @param {string} outPath
 */
async function downloadFlagPng(code, outPath) {
  const cc = String(code || "").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) throw new Error(`invalid country code: ${code}`);
  const urls = [
    `https://flagcdn.com/w640/${cc}.png`,
    `https://flagcdn.com/w320/${cc}.png`,
    `https://flagcdn.com/${cc}.svg`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastErr = new Error(`${url} → ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Prefer raster; skip tiny/empty.
      if (buf.length < 64) {
        lastErr = new Error(`${url} empty`);
        continue;
      }
      // SVG won't overlay cleanly via png decoder — skip.
      if (url.endsWith(".svg")) {
        lastErr = new Error("svg not supported for overlay");
        continue;
      }
      fs.writeFileSync(outPath, buf);
      return outPath;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("flag download failed");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (c) => {
      err += c.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim().split("\n").slice(-6).join("\n") || `ffmpeg exit ${code}`));
    });
  });
}

/**
 * Composite winner flag + label onto the blank-flag landscape thumb.
 * @param {{ basePath?: string, outPath: string, winner: { code: string, name: string } }} opts
 */
export async function buildWinnerThumbnail({
  basePath = path.join(ROOT, "assets/thumbnail-yt-1280.jpg"),
  outPath,
  winner,
}) {
  if (!winner?.code) throw new Error("winner.code required");
  if (!fs.existsSync(basePath)) throw new Error(`base thumb missing: ${basePath}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-winner-thumb-"));
  const flagPath = path.join(tmpDir, "flag.png");
  try {
    await downloadFlagPng(winner.code, flagPath);
    const font = resolveFont();
    const label = `${String(winner.name || winner.code).trim().toUpperCase()} WINS`;
    const { x, y, w, h } = FLAG_SLOT;
    const drawtextOpts = [
      font ? `fontfile=${font}` : null,
      `text='${escapeDrawtext(label)}'`,
      "fontsize=44",
      "fontcolor=0xFFD278",
      "borderw=4",
      "bordercolor=black@0.9",
      "x=(w-text_w)/2",
      "y=208",
    ]
      .filter(Boolean)
      .join(":");
    // Cover only the gold subtitle band under FLAG BATTLE, then write winner.
    const filterComplex = [
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=rgba,pad=${w + 6}:${h + 6}:3:3:black@0.55[fg]`,
      `[0:v][fg]overlay=${x - 3}:${y - 3}[over]`,
      `[over]drawbox=x=300:y=188:w=680:h=85:color=0x050a12@1.0:t=fill[box]`,
      `[box]drawtext=${drawtextOpts}`,
    ].join(";");

    await runFfmpeg([
      "-y",
      "-i",
      basePath,
      "-i",
      flagPath,
      "-filter_complex",
      filterComplex,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-q:v",
      "3",
      outPath,
    ]);

    const size = fs.statSync(outPath).size;
    if (size > 2 * 1024 * 1024) {
      // Re-encode smaller if somehow over YouTube's 2MB thumb limit.
      const slim = `${outPath}.slim.jpg`;
      await runFfmpeg([
        "-y",
        "-i",
        outPath,
        "-frames:v",
        "1",
        "-update",
        "1",
        "-q:v",
        "6",
        slim,
      ]);
      fs.renameSync(slim, outPath);
    }
    return outPath;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Upload winner thumb + retitle the YouTube broadcast.
 * @returns {Promise<{ ok: boolean, title?: string, thumbPath?: string, error?: string }>}
 */
export async function revealWinnerOnYoutube({
  youtube,
  videoId,
  winner,
  baseTitle,
  description,
  tags,
  keywords,
  categoryId = "20",
  baseThumbPath,
}) {
  if (!youtube || !videoId || !winner?.code) {
    return { ok: false, error: "missing youtube/videoId/winner" };
  }
  const outPath = path.join(
    os.tmpdir(),
    `flagbattle-winner-${String(winner.code).toLowerCase()}.jpg`
  );
  try {
    await buildWinnerThumbnail({
      basePath: baseThumbPath,
      outPath,
      winner,
    });
    const thumbResult = await setVideoThumbnail(youtube, videoId, outPath);
    const title = withWinnerTitle(baseTitle, winner.name || winner.code);
    await applyVideoDiscovery(youtube, videoId, {
      title,
      description,
      tags,
      keywords,
      categoryId,
    });
    console.log(
      `[winner-thumb] Updated thumbnail + title for ${winner.name || winner.code}: ${title}`
    );
    return {
      ok: Boolean(thumbResult?.ok),
      title,
      thumbPath: outPath,
    };
  } catch (err) {
    console.warn("[winner-thumb] reveal failed:", err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}
