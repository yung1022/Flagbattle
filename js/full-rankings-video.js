/**
 * Landscape (16:9) full battle rankings video.
 * Reveals every country one-by-one (last place → #1) with 5s national anthem each.
 * Encodes faster than realtime via WebCodecs + webm-muxer (video + Opus audio).
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
const HOLD_SEC = 3;
const SAMPLE_RATE = 48000;
const AUDIO_CH = 2;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

function easeOutCubic(t) {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
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

/**
 * Resolve a battle from an explicit battle, a Final stream + history, or streams list.
 */
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

/**
 * @returns {Array<{
 *   code: string,
 *   name: string,
 *   place: number,
 *   avgQual: number|null,
 *   finalist: boolean,
 *   img: CanvasImageSource|null,
 *   heroImg: CanvasImageSource|null,
 * }>}
 */
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
      imgUrl: flagUrl(c.code, 40),
      heroUrl: flagUrl(c.code, 320),
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
  await mapPool(rows, 24, async (r) => {
    const [img, hero] = await Promise.all([
      loadImage(r.imgUrl),
      loadImage(r.heroUrl),
    ]);
    r.img = img;
    r.heroImg = hero || img;
  });
  reportProgress(onProgress, "Flags ready", 0.28);
}

/**
 * Load anthems in parallel (rate-limited). Fanfare fallback when missing.
 * @returns {Promise<AudioBuffer[]>} aligned with reveal order
 */
async function loadAnthems(revealRows, audioCtx, onProgress) {
  const total = revealRows.length;
  let done = 0;
  const bufs = await mapPool(revealRows, 4, async (row) => {
    let buf = await loadAnthemBuffer(row.code, audioCtx);
    if (!buf) buf = makeFanfareBuffer(audioCtx, Math.min(10, row.place));
    done += 1;
    if (done % 3 === 0 || done === total) {
      reportProgress(
        onProgress,
        `Anthem ${done}/${total}`,
        0.28 + 0.22 * (done / total)
      );
    }
    return buf;
  });
  return bufs;
}

/** Resample / mix an AudioBuffer to stereo @ SAMPLE_RATE, clipped to ANTHEM_SEC. */
async function normalizeAnthemBuffer(buf, audioCtx) {
  if (!buf) return null;
  const dur = Math.min(ANTHEM_SEC, buf.duration || ANTHEM_SEC);
  const frames = Math.max(1, Math.floor(SAMPLE_RATE * dur));
  const OfflineCtx =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    // Manual copy / truncate without resample
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
  // Soft fade out last 0.25s
  const end = dur;
  gain.gain.setValueAtTime(0.9, Math.max(0, end - 0.25));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  src.connect(gain);
  gain.connect(offline.destination);
  src.start(0, 0, dur);
  return offline.startRendering();
}

/**
 * Reveal order: worst place first → #1 last (same drama as Top 10 Shorts).
 * @returns {{ slots: Array<{entry:object, start:number, dur:number}>, total: number }}
 */
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

function paintReveal(ctx, { rows, battle, channelName, t, slots, total }) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0d1c28");
  bg.addColorStop(0.55, "#08131c");
  bg.addColorStop(1, "#050b11");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const inHold = t >= slots[slots.length - 1].start + slots[slots.length - 1].dur;
  const slot = activeSlotAt(slots, t);
  const entry = slot.entry;
  const local = inHold ? 1 : clamp01((t - slot.start) / slot.dur);
  const pop = easeOutCubic(Math.min(1, local * 3.2));

  const pulse = 0.07 + 0.04 * Math.sin(t * 2.4);
  const glow = ctx.createRadialGradient(520, 420, 40, 520, 420, 520);
  glow.addColorStop(
    0,
    entry.finalist
      ? `rgba(230,184,74,${pulse})`
      : `rgba(46,196,182,${pulse * 0.85})`
  );
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 48px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("FLAG BATTLE", 48, 42);

  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 26px "Manrope", system-ui, sans-serif';
  ctx.fillText("FULL RANKINGS", 300, 44);

  const when = battle?.startedAt ? new Date(battle.startedAt) : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";
  const winnerName =
    battle?.winner?.name || battle?.final?.final?.winner?.name || "";
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '600 16px "Manrope", system-ui, sans-serif';
  ctx.fillText(
    [whenLabel, winnerName ? `Winner · ${winnerName}` : "", `${rows.length} countries`]
      .filter(Boolean)
      .join("   ·   "),
    48,
    78
  );

  // Progress
  const revealedCount = inHold
    ? slots.length
    : slots.findIndex((s) => s === slot) + 1;
  ctx.textAlign = "right";
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 18px "Manrope", system-ui, sans-serif';
  ctx.fillText(`${revealedCount} / ${slots.length}`, W - 48, 44);

  const barX = 48;
  const barW = W - 96;
  const barY = 100;
  roundRectFill(ctx, barX, barY, barW, 8, 4, "rgba(255,255,255,0.08)");
  roundRectFill(
    ctx,
    barX,
    barY,
    barW * clamp01(t / Math.max(0.001, total)),
    8,
    4,
    entry.finalist ? "#e6b84a" : "#2ec4b6"
  );

  // ——— Hero (left) ———
  const heroX = 80;
  const heroY = 160;
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.65 * pop;
  ctx.translate(0, (1 - pop) * 28);

  ctx.textAlign = "left";
  ctx.fillStyle = entry.finalist ? "#e6b84a" : "#2ec4b6";
  ctx.font = '700 120px "Bebas Neue", Impact, sans-serif';
  ctx.fillText(`#${entry.place}`, heroX, heroY + 70);

  const fw = 420;
  const fh = 280;
  const fx = heroX;
  const fy = heroY + 110;
  roundRectFill(ctx, fx - 8, fy - 8, fw + 16, fh + 16, 18, "rgba(0,0,0,0.35)");
  if (entry.heroImg || entry.img) {
    roundRectPath(ctx, fx, fy, fw, fh, 14);
    ctx.save();
    ctx.clip();
    ctx.drawImage(entry.heroImg || entry.img, fx, fy, fw, fh);
    ctx.restore();
  } else {
    roundRectFill(ctx, fx, fy, fw, fh, 14, "#1a3040");
  }

  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 44px "Manrope", system-ui, sans-serif';
  ctx.fillText(String(entry.name).toUpperCase(), heroX, fy + fh + 50, 900);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 22px "Manrope", system-ui, sans-serif';
  const meta = [
    entry.finalist ? "FINALIST" : "NON-QUALIFIER",
    `Avg qualifying · ${formatAvg(entry.avgQual)}`,
  ].join("    ·    ");
  ctx.fillText(meta, heroX, fy + fh + 92);

  ctx.restore();

  // ——— Revealed list (right) ———
  const listX = 1100;
  const listTop = 140;
  const listW = W - listX - 48;
  const rowH = 34;
  const visible = Math.floor((H - listTop - 70) / rowH);
  // Show most recently revealed entries (toward #1 at bottom of drama = end of list)
  const revealedEntries = [];
  for (const s of slots) {
    if (inHold || t >= s.start) revealedEntries.push(s.entry);
    if (!inHold && s === slot) break;
  }
  const startIdx = Math.max(0, revealedEntries.length - visible);

  roundRectFill(
    ctx,
    listX - 16,
    listTop - 16,
    listW + 32,
    visible * rowH + 32,
    16,
    "rgba(255,255,255,0.04)"
  );

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 14px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "left";
  ctx.fillText("REVEALED", listX, listTop - 28);

  for (let i = startIdx; i < revealedEntries.length; i++) {
    const e = revealedEntries[i];
    const y = listTop + (i - startIdx) * rowH;
    const isActive = !inHold && e.code === entry.code;
    if (isActive) {
      roundRectFill(ctx, listX - 8, y, listW + 16, rowH - 2, 8, "rgba(46,196,182,0.18)");
    }

    ctx.textAlign = "right";
    ctx.fillStyle = e.finalist ? "#e6b84a" : "#7f96a8";
    ctx.font = '800 15px "Manrope", system-ui, sans-serif';
    ctx.fillText(String(e.place), listX + 36, y + rowH / 2);

    const thumb = e.img;
    if (thumb) {
      roundRectPath(ctx, listX + 48, y + 8, 24, 16, 3);
      ctx.save();
      ctx.clip();
      ctx.drawImage(thumb, listX + 48, y + 8, 24, 16);
      ctx.restore();
    }

    ctx.textAlign = "left";
    ctx.fillStyle = isActive ? "#f4f7fa" : "#c5d3de";
    ctx.font = `${isActive ? "800" : "600"} 15px "Manrope", system-ui, sans-serif`;
    let name = e.name;
    const nameMax = listW - 160;
    while (name.length > 3 && ctx.measureText(name).width > nameMax) {
      name = name.slice(0, -2);
    }
    if (name !== e.name) name = `${name}…`;
    ctx.fillText(name, listX + 80, y + rowH / 2);

    ctx.textAlign = "right";
    ctx.fillStyle = "#2ec4b6";
    ctx.font = '700 13px "Manrope", system-ui, sans-serif';
    ctx.fillText(formatAvg(e.avgQual), listX + listW - 4, y + rowH / 2);
  }

  // Footer
  ctx.textAlign = "left";
  ctx.fillStyle = "#5a7080";
  ctx.font = '600 14px "Manrope", system-ui, sans-serif';
  ctx.fillText(
    "5s national anthem each   ·   Gold = Finalist   ·   Avg = qualifying rounds",
    48,
    H - 28
  );
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = '800 22px "Bebas Neue", Impact, sans-serif';
  ctx.fillText(
    String(channelName || "FLAG BATTLE").toUpperCase().slice(0, 32),
    W - 48,
    H - 28
  );
}

/** Encode AudioBuffers onto an AudioEncoder timeline (microseconds). */
async function encodeAnthemAudio(audioEncoder, normalizedBufs, slots) {
  const frameSize = 960; // 20ms @ 48k
  for (let i = 0; i < slots.length; i++) {
    const buf = normalizedBufs[i];
    if (!buf) continue;
    const startUs = Math.round(slots[i].start * 1_000_000);
    const channels = Math.min(AUDIO_CH, buf.numberOfChannels);
    const totalFrames = buf.length;
    const planes = [];
    for (let ch = 0; ch < AUDIO_CH; ch++) {
      const src = buf.getChannelData(Math.min(ch, channels - 1));
      planes.push(src);
    }
    for (let offset = 0; offset < totalFrames; offset += frameSize) {
      const n = Math.min(frameSize, totalFrames - offset);
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
      if (audioEncoder.encodeQueueSize > 20) await sleep(0);
    }
  }
}

/**
 * Fast A/V encode with correct timestamps. Requires WebCodecs + webm-muxer.
 */
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
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") {
    throw new Error("WebCodecs VideoEncoder required for full rankings + anthems.");
  }
  if (typeof AudioEncoder !== "function" || typeof AudioData !== "function") {
    throw new Error("WebCodecs AudioEncoder required for full rankings + anthems.");
  }

  const { Muxer, ArrayBufferTarget } = await import(
    "https://esm.sh/webm-muxer@5.0.2"
  );

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
  if (!chosen) throw new Error("No supported WebCodecs video codec (VP9/VP8).");

  const audioOk = await AudioEncoder.isConfigSupported?.({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: AUDIO_CH,
    bitrate: 128_000,
  })
    .then((r) => r?.supported)
    .catch(() => false);
  if (!audioOk) throw new Error("Opus AudioEncoder not supported in this browser.");

  reportProgress(onProgress, "Preparing audio", 0.52);
  const normalized = [];
  for (let i = 0; i < anthemBufs.length; i++) {
    normalized.push(await normalizeAnthemBuffer(anthemBufs[i], audioCtx));
    if (i % 10 === 0) {
      reportProgress(
        onProgress,
        `Audio ${i + 1}/${anthemBufs.length}`,
        0.52 + 0.08 * ((i + 1) / anthemBufs.length)
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

  // Encode all audio first (timeline-based), then video frames.
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
    if (i % 20 === 0) {
      reportProgress(onProgress, "Encoding", 0.6 + 0.38 * (i / frameCount));
      await sleep(0);
    }
    if (encError) throw encError;
  }
  await videoEncoder.flush();
  videoEncoder.close();
  muxer.finalize();

  const blob = new Blob([target.buffer], { type: "video/webm" });
  if (!blob.size) throw new Error("Encoding produced an empty file.");
  return {
    blob,
    mimeType: "video/webm",
    durationSec: frameCount / fps,
  };
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

  reportProgress(opts.onProgress, "Loading anthems", 0.3);
  const anthemBufs = await loadAnthems(revealRows, audioCtx, opts.onProgress);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");

  const frameCount = Math.ceil(total * FPS);
  reportProgress(opts.onProgress, "Encoding", 0.5);

  let result;
  try {
    result = await recordAvFast({
      canvas,
      frameCount,
      fps: FPS,
      paint: (t) =>
        paintReveal(ctx, {
          rows,
          battle,
          channelName: opts.channelName,
          t,
          slots,
          total,
        }),
      slots,
      anthemBufs,
      audioCtx,
      onProgress: opts.onProgress,
    });
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
