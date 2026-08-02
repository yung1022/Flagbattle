/**
 * Vertical (~9:16) Short generators:
 * - Final Top 10: full-screen reveal #10 → #1, 5s national anthem each
 * - Season Top 10: same reveal with points + ↑/↓ rank change
 */

import { loadAnthemBuffer, makeFanfareBuffer } from "./anthem.js";
import { COUNTRIES } from "./countries.js";
import { buildPointsLeaderboard } from "./rankings-stats.js";
import { formatDelta } from "./rank-delta.js";

const W = 1080;
const H = 1920;
const FPS = 30;
const INTRO = 2.4;
const SLOT = 5;
const OUTRO = 3.2;
const COUNT = 10;
const TOTAL = INTRO + COUNT * SLOT + OUTRO;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
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

  const pulse = 0.15 + 0.05 * Math.sin(t * 2);
  const glow = ctx.createRadialGradient(W / 2, 280, 20, W / 2, 360, 720);
  glow.addColorStop(0, `rgba(46,196,182,${pulse})`);
  glow.addColorStop(1, "rgba(46,196,182,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawFooter(ctx, text) {
  ctx.fillStyle = "rgba(109,132,150,0.9)";
  ctx.font = '600 22px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, H - 48);
}

function drawIntro(ctx, t, mode, subtitle) {
  paintBg(ctx, t);
  const u = clamp01(t / INTRO);
  const fade = easeOutCubic(Math.min(1, u * 1.6));
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.fillStyle = "#f4f7fa";
  ctx.font = '700 86px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FLAG BATTLE", W / 2, 520);

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 96px "Bebas Neue", Impact, sans-serif';
  ctx.fillText(mode === "season" ? "SEASON TOP 10" : "FINAL TOP 10", W / 2, 640);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 32px "Manrope", system-ui, sans-serif';
  ctx.fillText(subtitle || "", W / 2, 720);

  if (u > 0.45) {
    ctx.globalAlpha = fade * Math.min(1, (u - 0.45) / 0.35);
    ctx.fillStyle = "#2ec4b6";
    ctx.font = '800 36px "Manrope", system-ui, sans-serif';
    ctx.fillText("Revealing #10 → #1 · anthems", W / 2, 820);
  }
  ctx.restore();
  drawFooter(
    ctx,
    mode === "season"
      ? "FLAG BATTLE · Season ranking"
      : "FLAG BATTLE · Final ranking"
  );
}

function drawDeltaChip(ctx, delta, x, y) {
  const info = formatDelta(delta);
  const up = delta != null && delta > 0;
  const down = delta != null && delta < 0;
  const label =
    delta == null || delta === 0 ? "—" : `${info.arrow}${info.text}`;
  const color = up ? "#4ade80" : down ? "#f87171" : "#8fa6b8";
  const bg = up
    ? "rgba(34,197,94,.18)"
    : down
      ? "rgba(248,113,113,.18)"
      : "rgba(255,255,255,.08)";
  roundRectFill(ctx, x - 90, y - 36, 180, 72, 16, bg);
  ctx.fillStyle = color;
  ctx.font = '900 40px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, y);
}

/** Full-screen single-country reveal for one 5s slot. */
function drawRevealCard(ctx, { t, mode, entry, slotLocal, subtitle }) {
  paintBg(ctx, t);
  const pop = easeOutBack(clamp01(slotLocal / 0.45));
  const fade = clamp01(slotLocal / 0.18);

  ctx.save();
  ctx.globalAlpha = fade;

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 56px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(mode === "season" ? "SEASON TOP 10" : "FINAL TOP 10", W / 2, 150);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 26px "Manrope", system-ui, sans-serif';
  ctx.fillText(subtitle || "", W / 2, 200);

  const cardX = 70;
  const cardY = 260;
  const cardW = W - 140;
  const cardH = 1180;

  ctx.save();
  ctx.translate(W / 2, cardY + cardH / 2);
  ctx.scale(0.92 + 0.08 * pop, 0.92 + 0.08 * pop);
  ctx.translate(-W / 2, -(cardY + cardH / 2));

  roundRectFill(ctx, cardX, cardY, cardW, cardH, 28, "rgba(18,36,51,0.9)");
  ctx.strokeStyle =
    entry.rank === 1
      ? "rgba(255,217,120,0.65)"
      : entry.rank <= 3
        ? "rgba(230,184,74,0.45)"
        : "rgba(46,196,182,0.35)";
  ctx.lineWidth = 4;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.stroke();

  const rankColor = medalColor(entry.rank);
  ctx.fillStyle = rankColor;
  ctx.font = '700 160px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(`#${entry.rank}`, W / 2, cardY + 180);

  if (entry.img) {
    const fw = 420;
    const fh = 280;
    const fx = W / 2 - fw / 2;
    const fy = cardY + 230;
    roundRectFill(ctx, fx - 10, fy - 10, fw + 20, fh + 20, 16, "rgba(0,0,0,.35)");
    ctx.save();
    roundRectPath(ctx, fx, fy, fw, fh, 12);
    ctx.clip();
    const box = fitContain(
      entry.img.naturalWidth || entry.img.width || 1,
      entry.img.naturalHeight || entry.img.height || 1,
      fw,
      fh
    );
    ctx.drawImage(entry.img, fx + box.x, fy + box.y, box.w, box.h);
    ctx.restore();
  }

  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 64px "Manrope", system-ui, sans-serif';
  ctx.fillText(entry.name || entry.code.toUpperCase(), W / 2, cardY + 620, cardW - 80);

  if (mode === "season") {
    ctx.fillStyle = "#8fa6b8";
    ctx.font = '700 36px "Manrope", system-ui, sans-serif';
    ctx.fillText(`${entry.points ?? 0} season points`, W / 2, cardY + 700);
    drawDeltaChip(ctx, entry.delta, W / 2, cardY + 790);
    ctx.fillStyle = "#8fa6b8";
    ctx.font = '700 26px "Manrope", system-ui, sans-serif';
    ctx.fillText("rank change vs previous Final", W / 2, cardY + 870);
  } else {
    ctx.fillStyle = entry.rank === 1 ? "#ffd978" : "#8fa6b8";
    ctx.font = '700 34px "Manrope", system-ui, sans-serif';
    ctx.fillText(
      entry.rank === 1 ? "LAST FLAG STANDING" : "Final placement",
      W / 2,
      cardY + 720
    );
  }

  // Anthem cue
  const pulse = 0.55 + 0.45 * Math.sin(slotLocal * 6);
  ctx.fillStyle = `rgba(46,196,182,${0.55 + 0.35 * pulse})`;
  ctx.font = '800 32px "Manrope", system-ui, sans-serif';
  ctx.fillText("♪ National anthem", W / 2, cardY + 1000);

  ctx.restore(); // scale
  ctx.restore(); // fade

  // Mini strip of revealed ranks so far (this + previous)
  drawProgressStrip(ctx, entry);

  drawFooter(
    ctx,
    mode === "season"
      ? "FLAG BATTLE · Season Top 10"
      : "FLAG BATTLE · Final Top 10"
  );
}

function drawProgressStrip(ctx, current) {
  // Show small ticks for ranks 10..1 under the card
  const y = 1520;
  const ranks = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const gap = 92;
  const startX = W / 2 - ((ranks.length - 1) * gap) / 2;
  for (let i = 0; i < ranks.length; i++) {
    const rank = ranks[i];
    const x = startX + i * gap;
    const done = rank >= current.rank; // revealed already or current (#10 first)
    const isCurrent = rank === current.rank;
    ctx.beginPath();
    ctx.arc(x, y, isCurrent ? 14 : 10, 0, Math.PI * 2);
    ctx.fillStyle = isCurrent
      ? medalColor(rank)
      : done
        ? "rgba(46,196,182,0.55)"
        : "rgba(255,255,255,0.12)";
    ctx.fill();
    if (isCurrent) {
      ctx.fillStyle = "#f4f7fa";
      ctx.font = '700 22px "Bebas Neue", Impact, sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(`#${rank}`, x, y + 40);
    }
  }
}

function drawOutro(ctx, t, mode, entries, subtitle) {
  paintBg(ctx, t);
  const local = Math.max(0, t - (INTRO + COUNT * SLOT));
  const fade = easeOutCubic(clamp01(local / 0.5));
  ctx.save();
  ctx.globalAlpha = fade;

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 64px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(mode === "season" ? "SEASON TOP 10" : "FINAL TOP 10", W / 2, 140);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 26px "Manrope", system-ui, sans-serif';
  ctx.fillText(subtitle || "", W / 2, 190);

  const listTop = 240;
  const rowH = 140;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const y = listTop + i * rowH;
    roundRectFill(
      ctx,
      60,
      y,
      W - 120,
      rowH - 14,
      14,
      e.rank <= 3 ? "rgba(230,184,74,0.12)" : "rgba(18,36,51,0.8)"
    );
    ctx.fillStyle = medalColor(e.rank);
    ctx.font = '700 52px "Bebas Neue", Impact, sans-serif';
    ctx.textAlign = "left";
    ctx.fillText(`#${e.rank}`, 84, y + 78);

    if (e.img) {
      const fw = 96;
      const fh = 64;
      const fx = 200;
      const fy = y + 28;
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
    }

    ctx.fillStyle = "#f4f7fa";
    ctx.font = '800 36px "Manrope", system-ui, sans-serif';
    ctx.textAlign = "left";
    ctx.fillText(e.name, 320, y + (mode === "season" ? 58 : 78), 420);

    if (mode === "season") {
      ctx.fillStyle = "#8fa6b8";
      ctx.font = '700 24px "Manrope", system-ui, sans-serif';
      ctx.fillText(`${e.points} pts`, 320, y + 96);
      const info = formatDelta(e.delta);
      const up = e.delta != null && e.delta > 0;
      const down = e.delta != null && e.delta < 0;
      ctx.fillStyle = up ? "#4ade80" : down ? "#f87171" : "#8fa6b8";
      ctx.font = '900 32px "Manrope", system-ui, sans-serif';
      ctx.textAlign = "right";
      const label =
        e.delta == null || e.delta === 0 ? "—" : `${info.arrow}${info.text}`;
      ctx.fillText(label, W - 96, y + 78);
    }
  }

  ctx.restore();
  drawFooter(ctx, "FLAG BATTLE");
}

async function prepareEntries(rows) {
  const top = rows.slice(0, COUNT);
  const imgs = await Promise.all(
    top.map((r) =>
      loadImage(
        r.img || `https://flagcdn.com/w320/${String(r.code || "").toLowerCase()}.png`
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
    // Gentle pacing — Wikimedia rate-limits burst downloads.
    if (i < revealEntries.length - 1) await sleep(180);
  }
  return out;
}

function scheduleAnthems(audioCtx, dest, buffers) {
  const gain = audioCtx.createGain();
  gain.gain.value = 0.85;
  gain.connect(dest);
  const startAt = audioCtx.currentTime + INTRO + 0.05;
  for (let i = 0; i < buffers.length; i++) {
    const when = startAt + i * SLOT;
    const buf = buffers[i];
    if (!buf) continue;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.9, when + 0.08);
    const end = when + Math.min(SLOT, buf.duration);
    g.gain.setValueAtTime(0.9, Math.max(when + 0.08, end - 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(g);
    g.connect(gain);
    src.start(when, 0, Math.min(SLOT, buf.duration));
    src.stop(end + 0.05);
  }
}

async function recordTop10Short({
  mode,
  subtitle,
  entries,
  onProgress,
}) {
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

  // Reveal order: #10 first → #1 last
  const revealEntries = [...entries].sort((a, b) => b.rank - a.rank);

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
  scheduleAnthems(audioCtx, dest, anthemBufs);
  recorder.start(200);

  const t0 = performance.now();
  const frameMs = 1000 / FPS;
  let frame = 0;
  while (true) {
    const t = (performance.now() - t0) / 1000;
    if (t >= TOTAL) break;

    if (t < INTRO) {
      drawIntro(ctx, t, mode, subtitle);
      reportProgress(onProgress, "Intro", t / TOTAL);
    } else if (t < INTRO + COUNT * SLOT) {
      const elapsed = t - INTRO;
      const revealIndex = Math.min(COUNT - 1, Math.floor(elapsed / SLOT));
      const slotLocal = elapsed - revealIndex * SLOT;
      const entry = revealEntries[revealIndex];
      drawRevealCard(ctx, {
        t,
        mode,
        entry,
        slotLocal,
        subtitle,
      });
      reportProgress(
        onProgress,
        `#${entry.rank} ${entry.name}`,
        t / TOTAL
      );
    } else {
      drawOutro(ctx, t, mode, entries, subtitle);
      reportProgress(onProgress, "Top 10 board", t / TOTAL);
    }

    frame += 1;
    const target = t0 + frame * frameMs;
    const wait = target - performance.now();
    if (wait > 8) await sleep(wait);
    else await nextFrame();
  }

  drawOutro(ctx, TOTAL, mode, entries, subtitle);
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
  return { blob, mimeType, durationSec: TOTAL, mode };
}

/**
 * Stream Final Short — top 10 of that Final, #10→#1, 5s national anthem each.
 */
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

/**
 * Season ranking Short — top 10 season points with ↑/↓ rank change, anthems.
 */
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
