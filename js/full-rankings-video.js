/**
 * Landscape (16:9) full battle rankings video.
 * Format: reveal every country ONE AT A TIME (last place → #1),
 * each with 5 seconds of national anthem (+ place & avg qualifying).
 *
 * Fast path: WebCodecs + vendored webm-muxer (faster than realtime).
 * Fallback: MediaRecorder + AudioContext (same as Top 10 Shorts; realtime).
 */

import { loadAnthemBuffer, makeFanfareBuffer } from "./anthem.js";
import { COUNTRIES, flagUrl } from "./countries.js";
import {
  averageQualifyingRating,
  battleResultForBattle,
  isFinalistInBattle,
  pairBattles,
} from "./rankings-stats.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const ANTHEM_SEC = 5;
const HOLD_SEC = 4;
const SAMPLE_RATE = 48000;
const AUDIO_CH = 2;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

function easeOutBack(t) {
  const c = 1.70158;
  const x = clamp01(t);
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function pickMime() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) {
      return type;
    }
  }
  return "video/webm";
}

function reportProgress(onProgress, phase, progress) {
  if (!onProgress) return;
  try {
    onProgress({ phase, progress: clamp01(progress) });
  } catch {
    /* ignore */
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundRectFill(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function resolveBattle(opts = {}) {
  if (opts.battle?.final || opts.battle?.qualifying) return opts.battle;
  const streams = opts.streams || [];
  const battles = pairBattles(streams);
  if (opts.stream?.id) {
    const hit = battles.find(
      (b) =>
        b.final?.id === opts.stream.id ||
        b.qualifying?.id === opts.stream.id ||
        b.id === opts.stream.id ||
        b.id.includes(opts.stream.id)
    );
    if (hit) return hit;
    return {
      id: opts.stream.id,
      qualifying: Array.isArray(opts.stream.rounds) ? opts.stream : null,
      final: opts.stream,
      startedAt: opts.stream.startedAt || null,
      ended: true,
      winner: opts.stream.final?.winner || opts.stream.winner || null,
    };
  }
  return (
    battles.filter((b) => b.ended || b.final?.final?.ranking?.length).at(-1) ||
    null
  );
}

export function buildFullRankingRows(battle) {
  if (!battle) return [];
  const rows = [];
  for (const c of COUNTRIES) {
    const place = battleResultForBattle(battle, c.code);
    if (typeof place !== "number") continue;
    const avgRaw = averageQualifyingRating(battle.qualifying, c.code);
    rows.push({
      code: c.code,
      name: c.name,
      place,
      avgQual: Number.isFinite(avgRaw) ? avgRaw : null,
      finalist: isFinalistInBattle(battle, c.code),
      img: null,
      heroImg: null,
      imgUrl: flagUrl(c.code, 80),
      heroUrl: flagUrl(c.code, 640),
    });
  }
  rows.sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
  return rows;
}

function formatAvg(avg) {
  if (avg == null || !Number.isFinite(avg)) return "—";
  return avg < 10 ? avg.toFixed(1) : String(Math.round(avg * 10) / 10);
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function preloadFlags(rows, onProgress) {
  let done = 0;
  await mapPool(rows, 20, async (r) => {
    const [img, hero] = await Promise.all([
      loadImage(r.imgUrl),
      loadImage(r.heroUrl),
    ]);
    r.img = img;
    r.heroImg = hero || img;
    done += 1;
    if (done % 10 === 0 || done === rows.length) {
      reportProgress(
        onProgress,
        `Flags ${done}/${rows.length}`,
        0.04 + 0.2 * (done / rows.length)
      );
    }
  });
}

async function loadAnthems(revealRows, audioCtx, onProgress) {
  const total = revealRows.length;
  let done = 0;
  return mapPool(revealRows, 4, async (row) => {
    let buf = await loadAnthemBuffer(row.code, audioCtx);
    if (!buf) buf = makeFanfareBuffer(audioCtx, Math.min(10, row.place));
    done += 1;
    if (done % 2 === 0 || done === total) {
      reportProgress(
        onProgress,
        `Anthem ${done}/${total}`,
        0.24 + 0.28 * (done / total)
      );
    }
    return buf;
  });
}

async function normalizeAnthemBuffer(buf, audioCtx) {
  if (!buf) return null;
  const dur = Math.min(ANTHEM_SEC, buf.duration || ANTHEM_SEC);
  const frames = Math.max(1, Math.floor(SAMPLE_RATE * dur));
  const OfflineCtx =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    const out = audioCtx.createBuffer(AUDIO_CH, frames, SAMPLE_RATE);
    const copyFrames = Math.min(frames, buf.length);
    for (let ch = 0; ch < AUDIO_CH; ch++) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      out.copyToChannel(src.subarray(0, copyFrames), ch);
    }
    return out;
  }
  const offline = new OfflineCtx(AUDIO_CH, frames, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buf;
  const gain = offline.createGain();
  gain.gain.value = 0.9;
  gain.gain.setValueAtTime(0.9, Math.max(0, dur - 0.25));
  gain.gain.exponentialRampToValueAtTime(0.0001, dur);
  src.connect(gain);
  gain.connect(offline.destination);
  src.start(0, 0, dur);
  return offline.startRendering();
}

/** Last place first → #1 last. */
function buildTimeline(rows) {
  const reveal = [...rows].sort(
    (a, b) => b.place - a.place || a.name.localeCompare(b.name)
  );
  const slots = [];
  let t = 0;
  for (const entry of reveal) {
    slots.push({ entry, start: t, dur: ANTHEM_SEC });
    t += ANTHEM_SEC;
  }
  return { slots, reveal, total: t + HOLD_SEC };
}

function activeSlotAt(slots, t) {
  for (const s of slots) {
    if (t >= s.start && t < s.start + s.dur) return s;
  }
  return slots[slots.length - 1];
}

/**
 * One country fills the frame (spotlight). Not a static multi-column board.
 */
function paintSpotlight(ctx, { battle, channelName, t, slots, total }) {
  const inHold =
    t >= slots[slots.length - 1].start + slots[slots.length - 1].dur;
  const slot = activeSlotAt(slots, t);
  const entry = slot.entry;
  const local = inHold ? 1 : clamp01((t - slot.start) / slot.dur);
  const pop = easeOutBack(Math.min(1, local * 2.8));
  const slotIndex = slots.findIndex((s) => s === slot);
  const revealedCount = inHold ? slots.length : slotIndex + 1;

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#102436");
  bg.addColorStop(0.45, "#0a1620");
  bg.addColorStop(1, "#050b11");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const accent = entry.finalist ? "#e6b84a" : "#2ec4b6";
  const glow = ctx.createRadialGradient(W * 0.5, H * 0.42, 40, W * 0.5, H * 0.45, 700);
  glow.addColorStop(0, `${accent}33`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Top bar
  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 44px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("FLAG BATTLE", 48, 40);

  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 24px "Manrope", system-ui, sans-serif';
  ctx.fillText("FULL RANKINGS  ·  ONE BY ONE", 300, 42);

  const when = battle?.startedAt ? new Date(battle.startedAt) : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '600 16px "Manrope", system-ui, sans-serif';
  ctx.fillText(
    [whenLabel, `${revealedCount} / ${slots.length}`, "5s anthem each"]
      .filter(Boolean)
      .join("   ·   "),
    48,
    78
  );

  // Progress
  roundRectFill(ctx, 48, 100, W - 96, 10, 5, "rgba(255,255,255,0.08)");
  roundRectFill(
    ctx,
    48,
    100,
    (W - 96) * clamp01(t / Math.max(0.001, total)),
    10,
    5,
    accent
  );

  // ——— Spotlight card (center) ———
  ctx.save();
  ctx.translate(W / 2, H * 0.52);
  ctx.scale(0.88 + 0.12 * pop, 0.88 + 0.12 * pop);
  ctx.globalAlpha = 0.25 + 0.75 * pop;

  const cardW = 1100;
  const cardH = 620;
  const cx = -cardW / 2;
  const cy = -cardH / 2;
  roundRectFill(ctx, cx, cy, cardW, cardH, 28, "rgba(8,18,28,0.92)");
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  roundRectPath(ctx, cx, cy, cardW, cardH, 28);
  ctx.stroke();

  // Place
  ctx.textAlign = "center";
  ctx.fillStyle = accent;
  ctx.font = '700 140px "Bebas Neue", Impact, sans-serif';
  ctx.fillText(`#${entry.place}`, 0, cy + 100);

  // Flag
  const fw = 520;
  const fh = 346;
  const fx = -fw / 2;
  const fy = cy + 150;
  roundRectFill(ctx, fx - 10, fy - 10, fw + 20, fh + 20, 18, "rgba(0,0,0,0.45)");
  if (entry.heroImg || entry.img) {
    roundRectPath(ctx, fx, fy, fw, fh, 14);
    ctx.save();
    ctx.clip();
    ctx.drawImage(entry.heroImg || entry.img, fx, fy, fw, fh);
    ctx.restore();
  } else {
    roundRectFill(ctx, fx, fy, fw, fh, 14, "#1a3040");
  }

  // Name
  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 52px "Manrope", system-ui, sans-serif';
  ctx.fillText(String(entry.name).toUpperCase(), 0, fy + fh + 58, cardW - 80);

  // Meta row
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 24px "Manrope", system-ui, sans-serif';
  ctx.fillText(
    [
      entry.finalist ? "FINALIST" : "NON-QUALIFIER",
      `AVG QUALIFYING  ${formatAvg(entry.avgQual)}`,
    ].join("     ·     "),
    0,
    fy + fh + 108
  );

  ctx.restore();

  // Prev / next strip (tiny context — not a full board)
  const prev = slotIndex > 0 ? slots[slotIndex - 1].entry : null;
  const next = !inHold && slotIndex < slots.length - 1 ? slots[slotIndex + 1].entry : null;
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.fillStyle = "#5a7080";
  ctx.font = '600 16px "Manrope", system-ui, sans-serif';
  if (prev) {
    ctx.fillText(`← #${prev.place} ${prev.name}`, 48, H - 70);
  }
  ctx.textAlign = "right";
  if (next) {
    ctx.fillText(`Next · #${next.place} ${next.name} →`, W - 48, H - 70);
  }

  // Footer
  ctx.textAlign = "left";
  ctx.fillStyle = "#5a7080";
  ctx.font = '600 14px "Manrope", system-ui, sans-serif';
  ctx.fillText("National anthem · 5 seconds", 48, H - 28);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = '800 22px "Bebas Neue", Impact, sans-serif';
  ctx.fillText(
    String(channelName || "FLAG BATTLE").toUpperCase().slice(0, 32),
    W - 48,
    H - 28
  );
}

function scheduleAnthems(audioCtx, dest, buffers, slots) {
  const master = audioCtx.createGain();
  master.gain.value = 0.9;
  master.connect(dest);
  const base = audioCtx.currentTime + 0.08;
  for (let i = 0; i < slots.length; i++) {
    const { start, dur } = slots[i];
    const buf = buffers[i];
    if (!buf) continue;
    const when = base + start;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.95, when + 0.08);
    const end = when + Math.min(dur, buf.duration);
    g.gain.setValueAtTime(0.95, Math.max(when + 0.08, end - 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(g);
    g.connect(master);
    src.start(when, 0, Math.min(dur, buf.duration));
    src.stop(end + 0.05);
  }
}

async function encodeAnthemAudio(audioEncoder, normalizedBufs, slots) {
  const frameSize = 960;
  for (let i = 0; i < slots.length; i++) {
    const buf = normalizedBufs[i];
    if (!buf) continue;
    const startUs = Math.round(slots[i].start * 1_000_000);
    const channels = Math.min(AUDIO_CH, buf.numberOfChannels);
    const planes = [];
    for (let ch = 0; ch < AUDIO_CH; ch++) {
      planes.push(buf.getChannelData(Math.min(ch, channels - 1)));
    }
    for (let offset = 0; offset < buf.length; offset += frameSize) {
      const n = Math.min(frameSize, buf.length - offset);
      const data = new Float32Array(n * AUDIO_CH);
      for (let ch = 0; ch < AUDIO_CH; ch++) {
        data.set(planes[ch].subarray(offset, offset + n), ch * n);
      }
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: SAMPLE_RATE,
        numberOfFrames: n,
        numberOfChannels: AUDIO_CH,
        timestamp: startUs + Math.round((offset / SAMPLE_RATE) * 1_000_000),
        data,
      });
      audioEncoder.encode(audioData);
      audioData.close();
      if (audioEncoder.encodeQueueSize > 24) await sleep(0);
    }
  }
}

/** Fast WebCodecs path (vendored muxer — no CDN). */
async function recordAvFast({
  canvas,
  frameCount,
  fps,
  paint,
  slots,
  anthemBufs,
  audioCtx,
  onProgress,
}) {
  if (typeof VideoEncoder !== "function" || typeof AudioEncoder !== "function") {
    throw new Error("WebCodecs unavailable");
  }
  const { Muxer, ArrayBufferTarget } = await import("./vendor/webm-muxer.mjs");

  const codecCandidates = [
    { mux: "V_VP9", enc: "vp09.00.10.08" },
    { mux: "V_VP8", enc: "vp8" },
  ];
  let chosen = null;
  for (const c of codecCandidates) {
    const ok = await VideoEncoder.isConfigSupported?.({
      codec: c.enc,
      width: canvas.width,
      height: canvas.height,
      bitrate: 6_000_000,
      framerate: fps,
    })
      .then((r) => r?.supported)
      .catch(() => false);
    if (ok) {
      chosen = c;
      break;
    }
  }
  if (!chosen) throw new Error("No VP8/VP9 encoder");

  const audioOk = await AudioEncoder.isConfigSupported?.({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: AUDIO_CH,
    bitrate: 128_000,
  })
    .then((r) => r?.supported)
    .catch(() => false);
  if (!audioOk) throw new Error("Opus encoder unavailable");

  reportProgress(onProgress, "Preparing audio", 0.54);
  const normalized = [];
  for (let i = 0; i < anthemBufs.length; i++) {
    normalized.push(await normalizeAnthemBuffer(anthemBufs[i], audioCtx));
    if (i % 8 === 0) {
      reportProgress(
        onProgress,
        `Audio ${i + 1}/${anthemBufs.length}`,
        0.54 + 0.08 * ((i + 1) / anthemBufs.length)
      );
    }
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: chosen.mux,
      width: canvas.width,
      height: canvas.height,
      frameRate: fps,
    },
    audio: {
      codec: "A_OPUS",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: AUDIO_CH,
    },
  });

  let encError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encError = e;
    },
  });
  videoEncoder.configure({
    codec: chosen.enc,
    width: canvas.width,
    height: canvas.height,
    bitrate: 6_000_000,
    framerate: fps,
  });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      encError = e;
    },
  });
  audioEncoder.configure({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: AUDIO_CH,
    bitrate: 128_000,
  });

  await encodeAnthemAudio(audioEncoder, normalized, slots);
  await audioEncoder.flush();
  audioEncoder.close();
  if (encError) throw encError;

  const frameDurUs = Math.round(1_000_000 / fps);
  for (let i = 0; i < frameCount; i++) {
    paint(i / fps);
    const frame = new VideoFrame(canvas, {
      timestamp: i * frameDurUs,
      duration: frameDurUs,
    });
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (videoEncoder.encodeQueueSize > 12) await sleep(0);
    if (i % 30 === 0) {
      reportProgress(onProgress, "Encoding", 0.62 + 0.35 * (i / frameCount));
      await sleep(0);
    }
    if (encError) throw encError;
  }
  await videoEncoder.flush();
  videoEncoder.close();
  muxer.finalize();

  const blob = new Blob([target.buffer], { type: "video/webm" });
  if (!blob.size) throw new Error("Empty WebCodecs output");
  return { blob, mimeType: "video/webm", durationSec: frameCount / fps };
}

/**
 * Reliable realtime path (same idea as Top 10 Shorts).
 * Generation time ≈ video length.
 */
async function recordRealtime({
  canvas,
  ctx,
  total,
  paint,
  slots,
  anthemBufs,
  audioCtx,
  onProgress,
}) {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder unavailable");
  }
  const dest = audioCtx.createMediaStreamDestination();
  const stream = canvas.captureStream(FPS);
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);

  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };
  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () =>
      reject(recorder.error || new Error("Recording failed"));
  });

  scheduleAnthems(audioCtx, dest, anthemBufs, slots);
  recorder.start(200);

  const t0 = performance.now();
  const frameMs = 1000 / FPS;
  let frame = 0;
  while (true) {
    const t = (performance.now() - t0) / 1000;
    if (t >= total) break;
    paint(t);
    const slot = activeSlotAt(slots, t);
    reportProgress(
      onProgress,
      `#${slot.entry.place} ${slot.entry.name}`,
      0.55 + 0.4 * (t / total)
    );
    frame += 1;
    const target = t0 + frame * frameMs;
    const wait = target - performance.now();
    if (wait > 8) await sleep(wait);
    else await nextFrame();
  }
  paint(total);
  recorder.stop();
  await done;
  stream.getTracks().forEach((tr) => tr.stop());

  const blob = new Blob(chunks, {
    type: mimeType.includes("webm") ? "video/webm" : mimeType,
  });
  if (!blob.size) throw new Error("Empty MediaRecorder output");
  return { blob, mimeType, durationSec: total };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.battle]
 * @param {object} [opts.stream]
 * @param {Array} [opts.streams]
 * @param {string} [opts.channelName]
 * @param {(p:{phase:string,progress:number})=>void} [opts.onProgress]
 */
export async function generateFullRankingsVideo(opts = {}) {
  if (document.fonts?.ready) await document.fonts.ready;

  reportProgress(opts.onProgress, "Building ranks", 0.02);
  const battle = resolveBattle(opts);
  if (!battle) throw new Error("No finished battle to rank.");

  const rows = buildFullRankingRows(battle);
  if (!rows.length) throw new Error("No ranking rows for this battle.");

  const { slots, total } = buildTimeline(rows);
  const revealRows = slots.map((s) => s.entry);

  await preloadFlags(rows, opts.onProgress);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio API is not available.");
  const audioCtx = new AudioCtx({ sampleRate: SAMPLE_RATE });
  if (audioCtx.state === "suspended") await audioCtx.resume();

  reportProgress(opts.onProgress, "Loading anthems", 0.25);
  const anthemBufs = await loadAnthems(revealRows, audioCtx, opts.onProgress);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");

  const paint = (t) =>
    paintSpotlight(ctx, {
      battle,
      channelName: opts.channelName,
      t,
      slots,
      total,
    });

  const frameCount = Math.ceil(total * FPS);
  let result;
  try {
    try {
      reportProgress(opts.onProgress, "Fast encode", 0.52);
      result = await recordAvFast({
        canvas,
        frameCount,
        fps: FPS,
        paint,
        slots,
        anthemBufs,
        audioCtx,
        onProgress: opts.onProgress,
      });
    } catch (fastErr) {
      console.warn("Fast encode failed, using realtime recorder:", fastErr);
      reportProgress(
        opts.onProgress,
        `Realtime (~${Math.round(total / 60)}m)`,
        0.52
      );
      result = await recordRealtime({
        canvas,
        ctx,
        total,
        paint,
        slots,
        anthemBufs,
        audioCtx,
        onProgress: opts.onProgress,
      });
    }
  } finally {
    try {
      await audioCtx.close?.();
    } catch {
      /* ignore */
    }
  }

  reportProgress(opts.onProgress, "Done", 1);
  return {
    blob: result.blob,
    mimeType: result.mimeType,
    durationSec: result.durationSec,
    mode: "full-rankings",
    width: W,
    height: H,
    rows: rows.length,
    winner: battle.winner
      ? { code: battle.winner.code, name: battle.winner.name }
      : null,
  };
}
