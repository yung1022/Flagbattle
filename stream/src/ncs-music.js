/**
 * Download a NoCopyrightSounds (NCS) track for the livestream ambient bed.
 * Prefers S3 preview MP3s (direct audio/mpeg). Falls back gracefully.
 *
 * Credit format follows https://ncs.io usage policy — append to YT description.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ncs from "nocopyrightsounds-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CACHE_DIR = path.join(ROOT, "stream", ".cache", "ncs");
const BED_PATH = path.join(CACHE_DIR, "bed.mp3");
const META_PATH = path.join(CACHE_DIR, "bed.json");
const AMBIENT_PUBLIC = path.join(ROOT, ".data", "ambient.mp3");
const AMBIENT_META_PUBLIC = path.join(ROOT, ".data", "ambient.json");

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   path?: string,
 *   credit?: string,
 *   song?: { name: string, artists: string, url: string },
 *   error?: string
 * }>}
 */
export async function prepareNcsBed({ pages = 2 } = {}) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const songs = [];
    for (let page = 1; page <= Math.max(1, pages); page++) {
      const batch = await ncs.getSongs(page);
      if (Array.isArray(batch)) songs.push(...batch);
    }
    const usable = songs.filter((s) => s?.previewUrl || s?.download?.regular);
    if (!usable.length) {
      return { ok: false, error: "No NCS tracks with audio URLs" };
    }

    // Prefer a mid-list pick so we don't always hammer the newest release.
    const idx =
      Math.abs(hashDay()) % usable.length ||
      ((Date.now() / 60_000) | 0) % usable.length;
    const song = usable[idx];
    const audioUrl = song.previewUrl || song.download?.regular;
    const artists = (song.artists || [])
      .map((a) => a?.name || "")
      .filter(Boolean)
      .join(", ");
    const songUrl = song.url
      ? song.url.startsWith("http")
        ? song.url
        : `https://ncs.io${song.url}`
      : "https://ncs.io";

    console.log(`[ncs] Downloading “${song.name}”${artists ? ` — ${artists}` : ""}`);
    const res = await fetch(audioUrl, {
      headers: { Accept: "audio/mpeg,audio/*,*/*" },
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, error: `NCS download HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 50_000) {
      return { ok: false, error: `NCS file too small (${buf.length} bytes)` };
    }
    fs.writeFileSync(BED_PATH, buf);

    const meta = {
      name: song.name,
      artists,
      url: songUrl,
      previewUrl: song.previewUrl || null,
      downloadedAt: new Date().toISOString(),
      bytes: buf.length,
    };
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

    // Expose to the game server / browser ambient player.
    fs.mkdirSync(path.dirname(AMBIENT_PUBLIC), { recursive: true });
    fs.copyFileSync(BED_PATH, AMBIENT_PUBLIC);
    fs.writeFileSync(AMBIENT_META_PUBLIC, JSON.stringify(meta, null, 2));

    const credit = buildNcsCredit(meta);
    console.log(`[ncs] Bed ready (${(buf.length / 1e6).toFixed(1)} MB) → ${BED_PATH}`);
    return { ok: true, path: BED_PATH, credit, song: meta };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function buildNcsCredit(meta) {
  const name = meta?.name || "NCS track";
  const artists = meta?.artists ? ` — ${meta.artists}` : "";
  const url = meta?.url || "https://ncs.io";
  return (
    `Song: ${name}${artists}\n` +
    `Music provided by NoCopyrightSounds\n` +
    `Free Download/Stream: ${url}`
  );
}

function hashDay() {
  const d = new Date();
  return d.getUTCFullYear() * 1000 + (d.getUTCMonth() + 1) * 50 + d.getUTCDate();
}

export { BED_PATH, AMBIENT_PUBLIC };
