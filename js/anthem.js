/**
 * National anthem loading for Short generation.
 * Uses Wikimedia Commons audio (CORS-friendly) via data/anthems.json.
 * No nationalanthems.info / live tunnel required on GitHub Pages.
 */

import { pagesDataUrl } from "./public.js";

let urlMapPromise = null;
const bufferCache = new Map();

function normalizeCode(code) {
  return String(code || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

async function loadUrlMap() {
  if (urlMapPromise) return urlMapPromise;
  urlMapPromise = (async () => {
    const candidates = [];
    try {
      candidates.push(pagesDataUrl("anthems.json"));
    } catch {
      /* ignore */
    }
    candidates.push("../data/anthems.json", "./data/anthems.json", "data/anthems.json");

    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.urls && typeof data.urls === "object") return data.urls;
      } catch {
        /* try next */
      }
    }
    return {};
  })();
  return urlMapPromise;
}

/** Resolve Commons Special:FilePath → direct upload.wikimedia.org URL. */
async function resolveCommonsUploadUrl(url) {
  if (!url) return "";
  if (url.includes("upload.wikimedia.org")) return url;
  const m = String(url).match(/Special:FilePath\/(.+)$/i);
  if (!m) return url;
  const title = "File:" + decodeURIComponent(m[1]).replace(/_/g, " ");
  try {
    const api =
      "https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&format=json&origin=*&titles=" +
      encodeURIComponent(title);
    const res = await fetch(api, { mode: "cors", credentials: "omit" });
    if (!res.ok) return url;
    const json = await res.json();
    for (const p of Object.values(json.query?.pages || {})) {
      const u = p.imageinfo?.[0]?.url;
      if (u) return u;
    }
  } catch {
    /* keep original */
  }
  return url;
}

export async function anthemSourceUrl(code) {
  const c = normalizeCode(code);
  if (!c) return "";
  const map = await loadUrlMap();
  const raw = map[c] || "";
  if (!raw) return "";
  return resolveCommonsUploadUrl(raw);
}

async function fetchArrayBuffer(url, { retries = 4 } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        headers: { Accept: "audio/*,application/ogg,*/*" },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 900 * (i + 1)));
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        continue;
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("text/html")) {
        lastErr = new Error("got HTML instead of audio");
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
        continue;
      }
      return await res.arrayBuffer();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr || new Error("fetch failed");
}

/**
 * Decode anthem into an AudioBuffer (caller clips to ~5s).
 * @returns {Promise<AudioBuffer|null>}
 */
export async function loadAnthemBuffer(code, audioCtx) {
  const c = normalizeCode(code);
  if (!c || !audioCtx) return null;

  if (bufferCache.has(c)) return bufferCache.get(c);

  const url = await anthemSourceUrl(c);
  if (!url) return null;

  try {
    const raw = await fetchArrayBuffer(url);
    const buf = await audioCtx.decodeAudioData(raw.slice(0));
    bufferCache.set(c, buf);
    return buf;
  } catch {
    return null;
  }
}

/** Short synthesized brass fall-back when anthem cannot be fetched. */
export function makeFanfareBuffer(audioCtx, rank = 10) {
  const dur = 5;
  const sampleRate = audioCtx.sampleRate || 44100;
  const len = Math.floor(sampleRate * dur);
  const buf = audioCtx.createBuffer(1, len, sampleRate);
  const data = buf.getChannelData(0);
  const base = 220 * Math.pow(2, (11 - Math.min(10, Math.max(1, rank))) / 12);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 8) * Math.max(0, 1 - (t - 0.2) / 4.8);
    const wave =
      0.35 * Math.sin(2 * Math.PI * base * t) +
      0.2 * Math.sin(2 * Math.PI * base * 1.5 * t) +
      0.12 * Math.sin(2 * Math.PI * base * 2 * t);
    data[i] = wave * env * 0.45;
  }
  return buf;
}
