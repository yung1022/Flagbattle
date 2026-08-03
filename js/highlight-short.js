/**
 * Vertical (~9:16) Short generators — race-results style board:
 * - Large winner flag hero, two-column Top 10 cards
 * - Reveal #10 → #1 with national anthems
 * - Anthem lengths: #4–10 = 5s, #2–3 = 8s, #1 = 10s
 * - Footer = YouTube channel name
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

function fitCover(srcW, srcH, boxW, boxH) {
  const r = Math.max(boxW / Math.max(1, srcW), boxH / Math.max(1, srcH));
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

/** Soft mint board — race-results atmosphere (not flat). */
function paintBg(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, W * 0.2, H);
  g.addColorStop(0, "#d8efe6");
  g.addColorStop(0.45, "#c5e4d8");
  g.addColorStop(1, "#a9d4c4");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Faint “track” arcs
  ctx.save();
  ctx.strokeStyle = `rgba(60,90,80,${0.07 + 0.02 * Math.sin(t)})`;
  ctx.lineWidth = 18;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.ellipse(
      W * 0.55,
      H * 0.42,
      280 + i * 70,
      520 + i * 90,
      -0.35,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  }
  ctx.restore();
}

function fillPodiumGradient(ctx, x, y, w, h, rank) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  if (rank === 1) {
    g.addColorStop(0, "#ffe566");
    g.addColorStop(0.5, "#f0c84a");
    g.addColorStop(1, "#d4a017");
  } else if (rank === 2) {
    g.addColorStop(0, "#f2f5f8");
    g.addColorStop(0.5, "#c5ced6");
    g.addColorStop(1, "#8e9aa6");
  } else if (rank === 3) {
    g.addColorStop(0, "#f0b27a");
    g.addColorStop(0.5, "#d0894a");
    g.addColorStop(1, "#a05c28");
  } else {
    const hue = 195 + rank * 14;
    g.addColorStop(0, `hsla(${hue},45%,28%,0.95)`);
    g.addColorStop(1, `hsla(${hue},50%,16%,0.98)`);
  }
  return g;
}

function drawHeroFlag(ctx, img, y, h, waveT, revealed) {
  const pad = 56;
  const boxW = W - pad * 2;
  const boxH = h;
  const x = pad;

  ctx.save();
  ctx.shadowColor = "rgba(0,40,30,0.35)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 12;
  roundRectFill(ctx, x, y, boxW, boxH, 22, "rgba(255,255,255,0.35)");
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x, y, boxW, boxH, 22);
  ctx.clip();

  if (img && revealed) {
    const slices = 36;
    const sliceH = boxH / slices;
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    const cover = fitCover(iw, ih, boxW, boxH);
    for (let i = 0; i < slices; i++) {
      const sy = y + i * sliceH;
      const offset = Math.sin(waveT * 2.4 + i * 0.4) * 12;
      const srcY = Math.max(0, (-cover.y + i * sliceH) * (ih / cover.h));
      const srcH = Math.min(ih - srcY, (sliceH + 2) * (ih / cover.h));
      ctx.drawImage(
        img,
        0,
        srcY,
        iw,
        Math.max(1, srcH),
        x + cover.x + offset,
        sy,
        cover.w,
        sliceH + 2
      );
    }
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(x, y, boxW, boxH);
    ctx.fillStyle = "rgba(40,70,60,0.35)";
    ctx.font = '900 120px "Bebas Neue", Impact, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", x + boxW / 2, y + boxH / 2);
  }
  ctx.restore();
}

function drawResultCard(ctx, e, x, y, w, h, { revealed, isCurrent, slotLocal, mode }) {
  const rank = e.rank;
  const pop = isCurrent ? easeOutBack(clamp01((slotLocal || 0) / 0.4)) : 1;
  const alpha = revealed
    ? isCurrent
      ? Math.min(1, (slotLocal || 0) / 0.18)
      : 0.98
    : 0.22;

  ctx.save();
  ctx.globalAlpha = alpha;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const scale = isCurrent ? 0.92 + 0.08 * pop : 1;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  const grad = fillPodiumGradient(ctx, x, y, w, h, revealed ? rank : 99);
  roundRectFill(ctx, x, y, w, h, 16, revealed ? grad : "rgba(255,255,255,0.28)");

  if (isCurrent) {
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    roundRectPath(ctx, x + 2, y + 2, w - 4, h - 4, 14);
    ctx.stroke();
  }

  // Ghost rank
  ctx.fillStyle =
    rank <= 3 && revealed ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.12)";
  ctx.font = '900 92px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(revealed ? String(rank) : "?", x + w - 16, cy + 4);

  // Flag thumb
  const fw = 56;
  const fh = 38;
  const fx = x + 16;
  const fy = cy - fh / 2;
  roundRectFill(ctx, fx - 3, fy - 3, fw + 6, fh + 6, 8, "rgba(0,0,0,0.25)");
  if (e.img && revealed) {
    ctx.save();
    roundRectPath(ctx, fx, fy, fw, fh, 6);
    ctx.clip();
    const box = fitCover(
      e.img.naturalWidth || e.img.width || 1,
      e.img.naturalHeight || e.img.height || 1,
      fw,
      fh
    );
    ctx.drawImage(e.img, fx + box.x, fy + box.y, box.w, box.h);
    ctx.restore();
  }

  // Name
  const nameX = fx + fw + 14;
  ctx.fillStyle = revealed && rank <= 3 ? "#1a1a1a" : "#ffffff";
  if (!revealed) ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = '800 28px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const label = revealed ? String(e.name || "").toUpperCase() : "?????";
  ctx.fillText(label, nameX, mode === "season" && revealed ? cy - 12 : cy, w - 150);

  if (mode === "season" && revealed) {
    const info = formatDelta(e.delta);
    const up = e.delta != null && e.delta > 0;
    const down = e.delta != null && e.delta < 0;
    ctx.fillStyle = up ? "#166534" : down ? "#991b1b" : "rgba(255,255,255,0.75)";
    if (rank <= 3) {
      ctx.fillStyle = up ? "#166534" : down ? "#7f1d1d" : "rgba(0,0,0,0.55)";
    }
    ctx.font = '700 20px "Manrope", system-ui, sans-serif';
    const dLabel =
      e.delta == null || e.delta === 0 ? `${e.points ?? 0} pts` : `${info.arrow}${info.text} · ${e.points ?? 0} pts`;
    ctx.fillText(dLabel, nameX, cy + 16, w - 150);
  }

  // Rank pill
  if (revealed && rank <= 3) {
    roundRectFill(ctx, x + w - 54, y + 10, 42, 36, 10, "rgba(0,0,0,0.18)");
    ctx.fillStyle = "#111";
    ctx.font = '900 26px "Bebas Neue", Impact, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(String(rank), x + w - 33, y + 28);
  }

  ctx.restore();
}

/**
 * Race-results board: winner flag hero + 2-column Top 10.
 * Reveal fills cards from #10 → #1; hero flag becomes the winner once #1 is in.
 */
function drawListReveal(ctx, {
  t,
  mode,
  subtitle,
  entries,
  revealRank,
  slotLocal,
  channelName,
  heroImg,
  heroRevealed,
}) {
  paintBg(ctx, t);

  const heroY = 36;
  const heroH = 320;
  drawHeroFlag(ctx, heroImg, heroY, heroH, t, heroRevealed);

  const titleY = heroY + heroH + 58;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#14352c";
  ctx.font = '800 52px "Bebas Neue", Impact, sans-serif';
  const title =
    mode === "season" ? "SEASON TOP 10" : "FINAL TOP 10";
  ctx.fillText(title, W / 2, titleY);

  // Accent last word feel
  ctx.fillStyle = "#6bcf3f";
  ctx.font = '800 22px "Manrope", system-ui, sans-serif';
  ctx.fillText((subtitle || "FLAG BATTLE").toUpperCase(), W / 2, titleY + 40);

  const gridTop = titleY + 78;
  const gridBottom = H - 160;
  const gap = 18;
  const colGap = 22;
  const colW = (W - 64 - colGap) / 2;
  const leftX = 32;
  const rightX = 32 + colW + colGap;
  const rowH = (gridBottom - gridTop - gap * 4) / 5;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rank = e.rank;
    const col = rank <= 5 ? 0 : 1;
    const row = rank <= 5 ? rank - 1 : rank - 6;
    const x = col === 0 ? leftX : rightX;
    const y = gridTop + row * (rowH + gap);
    const revealed = revealRank == null || rank >= revealRank;
    const isCurrent = revealRank != null && rank === revealRank;

    drawResultCard(ctx, e, x, y, colW, rowH, {
      revealed,
      isCurrent,
      slotLocal,
      mode,
    });
  }

  // Channel name footer (replaces brand block like “PITSTOP”)
  const brand = String(channelName || "FLAG BATTLE").toUpperCase();
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#ffffff";
  ctx.font = '900 72px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(brand.slice(0, 28), W / 2, H - 78, W - 80);
  ctx.restore();
}

async function prepareEntries(rows) {
  const top = rows.slice(0, COUNT);
  const imgs = await Promise.all(
    top.map((r) =>
      loadImage(
        r.img ||
          `https://flagcdn.com/w320/${String(r.code || "").toLowerCase()}.png`
      )
    )
  );
  const heroes = await Promise.all(
    top.map((r) =>
      loadImage(
        `https://flagcdn.com/w1280/${String(r.code || "").toLowerCase()}.png`
      )
    )
  );
  return top.map((r, i) => ({
    ...r,
    rank: Number(r.rank) || i + 1,
    img: imgs[i],
    heroImg: heroes[i] || imgs[i],
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

async function recordTop10Short({
  mode,
  subtitle,
  entries,
  channelName,
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

  const { slots, total } = slotTimeline(entries);
  const revealEntries = slots.map((s) => s.entry);
  const winner = entries.find((e) => e.rank === 1) || entries[0];

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
    // Large hero flag = #1 winner (same role as the GP flag in results Shorts).
    const heroEntry = winner;

    drawListReveal(ctx, {
      t,
      mode,
      subtitle,
      entries,
      revealRank,
      slotLocal,
      channelName,
      heroImg: heroEntry?.heroImg || heroEntry?.img,
      heroRevealed: true,
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
    channelName,
    heroImg: winner?.heroImg || winner?.img,
    heroRevealed: true,
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
    channelName: opts.channelName || "FLAG BATTLE",
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
    channelName: opts.channelName || "FLAG BATTLE",
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
