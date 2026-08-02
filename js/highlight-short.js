/**
 * Vertical (~9:16) Short generators:
 * - Final / Season Top 10 as a list (#1 at top, #10 at bottom)
 * - Reveal #10 → #1 with national anthems
 * - Anthem lengths: #4–10 = 5s, #2–3 = 8s, #1 = 10s
 */

import { loadAnthemBuffer, makeFanfareBuffer } from "./anthem.js";
import { COUNTRIES } from "./countries.js";
import { buildPointsLeaderboard } from "./rankings-stats.js";
import { formatDelta } from "./rank-delta.js";

const W = 1080;
const H = 1920;
const FPS = 30;
const COUNT = 10;
const HOLD = 2.5; // brief hold after #1

function anthemSeconds(rank) {
  if (rank === 1) return 10;
  if (rank === 2 || rank === 3) return 8;
  return 5;
}

function slotTimeline(entries) {
  // Reveal order: #10 first → #1 last
  const reveal = [...entries].sort((a, b) => b.rank - a.rank);
  const slots = [];
  let t = 0;
  for (const e of reveal) {
    const dur = anthemSeconds(e.rank);
    slots.push({ entry: e, start: t, dur });
    t += dur;
  }
  return { slots, revealEnds: t, total: t + HOLD };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function easeOutBack(t) {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
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

function fitContain(srcW, srcH, boxW, boxH) {
  const r = Math.min(boxW / Math.max(1, srcW), boxH / Math.max(1, srcH));
  const w = srcW * r;
  const h = srcH * r;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
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

function formatWhen(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

function medalColor(rank) {
  if (rank === 1) return "#ffd978";
  if (rank === 2) return "#c5d0da";
  if (rank === 3) return "#d08b5a";
  return "#2ec4b6";
}

function paintBg(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0c1c28");
  g.addColorStop(0.5, "#071018");
  g.addColorStop(1, "#050b11");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const pulse = 0.12 + 0.04 * Math.sin(t * 2);
  const glow = ctx.createRadialGradient(W / 2, 220, 20, W / 2, 300, 640);
  glow.addColorStop(0, `rgba(46,196,182,${pulse})`);
  glow.addColorStop(1, "rgba(46,196,182,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawDeltaBadge(ctx, delta, x, y) {
  const info = formatDelta(delta);
  const up = delta != null && delta > 0;
  const down = delta != null && delta < 0;
  const label =
    delta == null || delta === 0 ? "—" : `${info.arrow}${info.text}`;
  const color = up ? "#4ade80" : down ? "#f87171" : "#8fa6b8";
  roundRectFill(
    ctx,
    x - 8,
    y - 26,
    140,
    52,
    14,
    up ? "rgba(34,197,94,.18)" : down ? "rgba(248,113,113,.18)" : "rgba(255,255,255,.08)"
  );
  ctx.fillStyle = color;
  ctx.font = '900 30px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 62, y);
}

/**
 * List board: row 0 = #1 (top), row 9 = #10 (bottom).
 * Reveals from #10 upward; current rank highlighted.
 */
function drawListReveal(ctx, { t, mode, subtitle, entries, revealRank, slotLocal, footer }) {
  paintBg(ctx, t);

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 58px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(mode === "season" ? "SEASON TOP 10" : "FINAL TOP 10", W / 2, 110);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 26px "Manrope", system-ui, sans-serif';
  ctx.fillText(subtitle || "", W / 2, 158);

  const listTop = 200;
  const rowH = 148;
  const padX = 48;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const y = listTop + i * rowH;
    const rank = e.rank;
    const revealed = revealRank == null || rank >= revealRank;
    const isCurrent = revealRank != null && rank === revealRank;
    const pop = isCurrent ? easeOutBack(clamp01((slotLocal || 0) / 0.45)) : 1;
    const alpha = revealed
      ? isCurrent
        ? Math.min(1, (slotLocal || 0) / 0.2)
        : 0.96
      : 0.16;

    ctx.save();
    ctx.globalAlpha = alpha;
    const midY = y + rowH / 2;
    const scale = isCurrent ? 0.94 + 0.06 * pop : 1;
    ctx.translate(W / 2, midY);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, -midY);

    roundRectFill(
      ctx,
      padX,
      y + 8,
      W - padX * 2,
      rowH - 16,
      18,
      isCurrent
        ? "rgba(255,255,255,.14)"
        : rank <= 3 && revealed
          ? "rgba(230,184,74,.10)"
          : "rgba(18,36,51,.85)"
    );

    if (isCurrent) {
      ctx.strokeStyle = `rgba(46,196,182,${0.55 * (1 - Math.min(1, (slotLocal || 0) / anthemSeconds(rank)))})`;
      ctx.lineWidth = 3;
      roundRectPath(ctx, padX, y + 8, W - padX * 2, rowH - 16, 18);
      ctx.stroke();
    }

    ctx.fillStyle = revealed ? medalColor(rank) : "rgba(255,255,255,.3)";
    ctx.font = '700 48px "Bebas Neue", Impact, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`#${rank}`, padX + 28, midY);

    if (e.img && revealed) {
      const fw = 100;
      const fh = 66;
      const fx = padX + 120;
      const fy = midY - fh / 2;
      roundRectFill(ctx, fx - 4, fy - 4, fw + 8, fh + 8, 10, "rgba(0,0,0,.35)");
      ctx.save();
      roundRectPath(ctx, fx, fy, fw, fh, 8);
      ctx.clip();
      const box = fitContain(
        e.img.naturalWidth || e.img.width || 1,
        e.img.naturalHeight || e.img.height || 1,
        fw,
        fh
      );
      ctx.drawImage(e.img, fx + box.x, fy + box.y, box.w, box.h);
      ctx.restore();
    } else {
      roundRectFill(ctx, padX + 120, midY - 33, 100, 66, 8, "rgba(255,255,255,.08)");
      if (!revealed) {
        ctx.fillStyle = "rgba(255,255,255,.35)";
        ctx.font = '900 36px "Manrope", system-ui, sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("?", padX + 170, midY);
      }
    }

    const nameX = padX + 250;
    ctx.fillStyle = "#f4f7fa";
    ctx.font = `800 ${isCurrent ? 40 : 34}px "Manrope", system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(
      revealed ? e.name : "?????",
      nameX,
      midY - (mode === "season" && revealed ? 16 : 0),
      mode === "season" ? 400 : 520
    );

    if (mode === "season" && revealed) {
      ctx.fillStyle = "#8fa6b8";
      ctx.font = '700 24px "Manrope", system-ui, sans-serif';
      ctx.fillText(`${e.points ?? 0} pts`, nameX, midY + 22);
      drawDeltaBadge(ctx, e.delta, W - padX - 160, midY);
    } else if (isCurrent && revealed) {
      ctx.fillStyle = "rgba(46,196,182,.9)";
      ctx.font = '800 24px "Manrope", system-ui, sans-serif';
      ctx.textAlign = "right";
      ctx.fillText("♪ anthem", W - padX - 36, midY);
    }

    ctx.restore();
  }

  ctx.fillStyle = "rgba(109,132,150,0.95)";
  ctx.font = '600 24px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(footer || "FLAG BATTLE", W / 2, H - 48);
}

async function prepareEntries(rows) {
  const top = rows.slice(0, COUNT);
  const imgs = await Promise.all(
    top.map((r) =>
      loadImage(
        r.img || `https://flagcdn.com/w160/${String(r.code || "").toLowerCase()}.png`
      )
    )
  );
  return top.map((r, i) => ({
    ...r,
    rank: Number(r.rank) || i + 1,
    img: imgs[i],
  }));
}

async function loadAnthems(revealEntries, audioCtx, onProgress) {
  const out = [];
  for (let i = 0; i < revealEntries.length; i++) {
    const e = revealEntries[i];
    reportProgress(
      onProgress,
      `Anthem ${i + 1}/${revealEntries.length}`,
      i / Math.max(1, revealEntries.length)
    );
    let buf = await loadAnthemBuffer(e.code, audioCtx);
    if (!buf) buf = makeFanfareBuffer(audioCtx, e.rank);
    out.push(buf);
    if (i < revealEntries.length - 1) await sleep(180);
  }
  return out;
}

function scheduleAnthems(audioCtx, dest, buffers, slots) {
  const gain = audioCtx.createGain();
  gain.gain.value = 0.85;
  gain.connect(dest);
  const base = audioCtx.currentTime + 0.05;
  for (let i = 0; i < slots.length; i++) {
    const { start, dur } = slots[i];
    const when = base + start;
    const buf = buffers[i];
    if (!buf) continue;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.9, when + 0.08);
    const end = when + Math.min(dur, buf.duration);
    g.gain.setValueAtTime(0.9, Math.max(when + 0.08, end - 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(g);
    g.connect(gain);
    src.start(when, 0, Math.min(dur, buf.duration));
    src.stop(end + 0.05);
  }
}

async function recordTop10Short({ mode, subtitle, entries, onProgress }) {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }
  if (!entries.length) throw new Error("No ranking entries to reveal.");

  if (document.fonts?.ready) await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");

  const { slots, total } = slotTimeline(entries);
  const revealEntries = slots.map((s) => s.entry);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio API is not available.");
  const audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const dest = audioCtx.createMediaStreamDestination();

  reportProgress(onProgress, "Loading anthems", 0.02);
  const anthemBufs = await loadAnthems(revealEntries, audioCtx, onProgress);

  const stream = canvas.captureStream(FPS);
  for (const track of dest.stream.getAudioTracks()) {
    stream.addTrack(track);
  }

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
    recorder.onerror = () => reject(recorder.error || new Error("Recording failed"));
  });

  reportProgress(onProgress, "Recording", 0.05);
  scheduleAnthems(audioCtx, dest, anthemBufs, slots);
  recorder.start(200);

  const t0 = performance.now();
  const frameMs = 1000 / FPS;
  let frame = 0;
  while (true) {
    const t = (performance.now() - t0) / 1000;
    if (t >= total) break;

    // Find active reveal slot
    let active = slots[slots.length - 1];
    for (const s of slots) {
      if (t >= s.start && t < s.start + s.dur) {
        active = s;
        break;
      }
    }
    const inHold = t >= slots[slots.length - 1].start + slots[slots.length - 1].dur;
    const revealRank = inHold ? null : active.entry.rank;
    const slotLocal = inHold ? 1 : t - active.start;

    drawListReveal(ctx, {
      t,
      mode,
      subtitle,
      entries,
      revealRank,
      slotLocal,
      footer: inHold
        ? "Top 10 complete"
        : `♪ #${active.entry.rank} ${active.entry.name} · ${anthemSeconds(active.entry.rank)}s`,
    });

    reportProgress(
      onProgress,
      inHold ? "Hold" : `#${active.entry.rank} ${active.entry.name}`,
      t / total
    );

    frame += 1;
    const target = t0 + frame * frameMs;
    const wait = target - performance.now();
    if (wait > 8) await sleep(wait);
    else await nextFrame();
  }

  drawListReveal(ctx, {
    t: total,
    mode,
    subtitle,
    entries,
    revealRank: null,
    slotLocal: 1,
    footer: "Top 10 complete",
  });

  recorder.stop();
  await done;
  stream.getTracks().forEach((tr) => tr.stop());
  try {
    await audioCtx.close();
  } catch {
    /* ignore */
  }

  const blob = new Blob(chunks, {
    type: mimeType.includes("webm") ? "video/webm" : mimeType,
  });
  if (!blob.size) throw new Error("Recording produced an empty file.");

  reportProgress(onProgress, "Done", 1);
  return { blob, mimeType, durationSec: total, mode };
}

export async function generateHighlightShort(stream, opts = {}) {
  const ranking = stream?.final?.ranking;
  if (!Array.isArray(ranking) || !ranking.length) {
    throw new Error("This stream has no Final ranking to turn into a Short.");
  }

  const rows = ranking.slice(0, COUNT).map((r, i) => ({
    code: String(r.code || "").toLowerCase(),
    name: r.name || String(r.code || "").toUpperCase(),
    rank: Number(r.rank) || i + 1,
    img: r.img,
  }));

  const entries = await prepareEntries(rows);
  return recordTop10Short({
    mode: "final",
    subtitle: formatWhen(stream.endedAt || stream.startedAt) || "Stream Final",
    entries,
    onProgress: opts.onProgress,
  });
}

export async function generateSeasonHighlightShort(history, opts = {}) {
  const board = buildPointsLeaderboard(history || [], COUNTRIES);
  if (!board.length) {
    throw new Error("No season points yet — finish a Final to build the ranking.");
  }

  const rows = board.slice(0, COUNT).map((r) => ({
    code: r.code,
    name: r.name,
    rank: r.rank,
    points: r.points,
    delta: r.delta,
    img: r.img,
  }));

  const entries = await prepareEntries(rows);
  return recordTop10Short({
    mode: "season",
    subtitle: "Points ranking · ↑ gained · ↓ lost",
    entries,
    onProgress: opts.onProgress,
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "flagbattle-short.webm";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
