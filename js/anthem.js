/**
 * National anthem loading for Short generation.
 * Prefer same-origin /api/anthem proxy (CORS-safe); fall back to direct URL.
 */

export function anthemSourceUrl(code, apiBase = "") {
  const c = String(code || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!c) return "";
  if (apiBase) return `${String(apiBase).replace(/\/$/, "")}/api/anthem?code=${c}`;
  return `https://www.nationalanthems.info/${c}.mp3`;
}

/**
 * Decode anthem into an AudioBuffer (full file; caller clips to ~5s).
 * @returns {Promise<AudioBuffer|null>}
 */
export async function loadAnthemBuffer(code, audioCtx, apiBase = "") {
  const c = String(code || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!c || !audioCtx) return null;

  const candidates = [];
  if (apiBase) candidates.push(anthemSourceUrl(c, apiBase));
  // Direct may fail in-browser due to missing CORS — still try.
  candidates.push(`https://www.nationalanthems.info/${c}.mp3`);

  for (const url of candidates) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) continue;
      const raw = await res.arrayBuffer();
      const buf = await audioCtx.decodeAudioData(raw.slice(0));
      return buf;
    } catch {
      /* try next */
    }
  }
  return null;
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
