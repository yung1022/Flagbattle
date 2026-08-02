/**
 * Vertical (~9:16) Short generators:
 * - Final Top 10 (stream) with 5s national anthem each (#10 → #1)
 * - Season Top 10 with ↑/↓ rank-change arrows + anthems
 */

import { loadAnthemBuffer, makeFanfareBuffer } from "./anthem.js";
import { COUNTRIES } from "./countries.js";
import { buildPointsLeaderboard } from "./rankings-stats.js";
import { formatDelta } from "./rank-delta.js";

const W = 1080;
const H = 1920;
const FPS = 30;
const INTRO = 2.2;
const SLOT = 5;
const COUNT = 10;
const TOTAL = INTRO + COUNT * SLOT;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const r = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * r;
  const h = srcH * r;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawText(ctx, text, x, y, opts = {}) {
  const {
    size = 48,
    weight = "800",
    color = "#fff",
    align = "center",
    baseline = "middle",
    maxWidth = null,
    shadow = true,
  } = opts;
  ctx.save();
  ctx.font = `${weight} ${size}px system-ui,Segoe UI,sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (shadow) {
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 3;
  }
  if (maxWidth) ctx.fillText(String(text), x, y, maxWidth);
  else ctx.fillText(String(text), x, y);
  ctx.restore();
}

function medalColor(rank) {
  if (rank === 1) return "#ffd700";
  if (rank === 2) return "#c0c8d4";
  if (rank === 3) return "#cd7f32";
  return "#7dd3fc";
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

function drawBg(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#070b16");
  g.addColorStop(0.45, "#101a33");
  g.addColorStop(1, "#1a0f28");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  for (let i = 0; i < 28; i++) {
    const x = ((i * 137 + t * 18) % (W + 80)) - 40;
    const y = ((i * 97 + t * 11) % (H + 80)) - 40;
    ctx.fillStyle = `rgba(255,255,255,${0.015 + (i % 5) * 0.004})`;
    ctx.beginPath();
    ctx.arc(x, y, 2 + (i % 4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBrand(ctx) {
  drawText(ctx, "FLAG BATTLE", W / 2, 86, {
    size: 42,
    weight: "900",
    color: "rgba(255,255,255,.72)",
    shadow: false,
  });
}

function drawDeltaBadge(ctx, delta, x, y) {
  const info = formatDelta(delta);
  const up = delta != null && delta > 0;
  const down = delta != null && delta < 0;
  const color = up ? "#4ade80" : down ? "#f87171" : "rgba(255,255,255,.45)";
  const label =
    delta == null || delta === 0
      ? "—"
      : `${info.arrow}${info.text}`;
  fillRoundRect(
    ctx,
    x - 8,
    y - 28,
    150,
    56,
    16,
    up ? "rgba(34,197,94,.18)" : down ? "rgba(248,113,113,.18)" : "rgba(255,255,255,.08)"
  );
  drawText(ctx, label, x + 68, y, {
    size: 34,
    weight: "900",
    color,
    align: "center",
    shadow: false,
  });
}

function drawIntroFrame(ctx, t, headline, subtitle) {
  drawBg(ctx, t);
  drawBrand(ctx);
  const p = easeOutCubic(clamp01(t / INTRO));
  ctx.save();
  ctx.globalAlpha = p;
  ctx.translate(0, (1 - p) * 40);
  drawText(ctx, headline, W / 2, H * 0.42, {
    size: 78,
    weight: "900",
    color: "#fff",
    maxWidth: W - 100,
  });
  drawText(ctx, subtitle, W / 2, H * 0.42 + 90, {
    size: 36,
    weight: "700",
    color: "rgba(255,255,255,.7)",
    maxWidth: W - 120,
  });
  drawText(ctx, "Top 10 · Anthems", W / 2, H * 0.42 + 160, {
    size: 32,
    weight: "800",
    color: "#7dd3fc",
    shadow: false,
  });
  ctx.restore();
}

function drawBoardFrame(ctx, { t, headline, subtitle, entries, mode, revealRank, slotLocal, footer }) {
  drawBg(ctx, t);
  drawBrand(ctx);
  drawText(ctx, headline, W / 2, 170, {
    size: 64,
    weight: "900",
    color: "#fff",
    maxWidth: W - 80,
  });
  if (subtitle) {
    drawText(ctx, subtitle, W / 2, 235, {
      size: 30,
      weight: "700",
      color: "rgba(255,255,255,.62)",
      maxWidth: W - 100,
      shadow: false,
    });
  }

  const listTop = 300;
  const rowH = 118;
  const padX = 48;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const y = listTop + i * rowH;
    const rank = e.rank;
    const revealed = revealRank == null || rank >= revealRank;
    const isCurrent = revealRank != null && rank === revealRank;
    const pop = isCurrent ? easeOutBack(clamp01((slotLocal || 0) / 0.55)) : revealed ? 1 : 0;
    const alpha = revealed
      ? isCurrent
        ? Math.min(1, (slotLocal || 0) / 0.25)
        : 0.95
      : 0.14;

    ctx.save();
    ctx.globalAlpha = alpha;
    const midY = y + rowH / 2;
    const scale = isCurrent ? 0.92 + 0.08 * pop : 1;
    ctx.translate(W / 2, midY);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, -midY);

    fillRoundRect(
      ctx,
      padX,
      y + 8,
      W - padX * 2,
      rowH - 16,
      22,
      isCurrent ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.06)"
    );

    const mc = medalColor(rank);
    fillRoundRect(ctx, padX + 16, y + 28, 78, 62, 14, "rgba(0,0,0,.35)");
    drawText(ctx, `#${rank}`, padX + 55, midY, {
      size: rank <= 3 ? 36 : 32,
      weight: "900",
      color: revealed ? mc : "rgba(255,255,255,.35)",
      shadow: false,
    });

    if (e.img && revealed) {
      const fw = 92;
      const fh = 62;
      const fx = padX + 118;
      const fy = midY - fh / 2;
      fillRoundRect(ctx, fx - 4, fy - 4, fw + 8, fh + 8, 10, "rgba(0,0,0,.35)");
      ctx.save();
      roundRect(ctx, fx, fy, fw, fh, 8);
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
      fillRoundRect(ctx, padX + 118, midY - 31, 92, 62, 8, "rgba(255,255,255,.08)");
      if (!revealed) {
        drawText(ctx, "?", padX + 164, midY, {
          size: 40,
          weight: "900",
          color: "rgba(255,255,255,.35)",
          shadow: false,
        });
      }
    }

    const nameX = padX + 240;
    drawText(ctx, revealed ? e.name : "?????", nameX, midY - (mode === "season" ? 14 : 0), {
      size: isCurrent ? 40 : 34,
      weight: "900",
      color: "#fff",
      align: "left",
      maxWidth: mode === "season" ? 400 : 520,
      shadow: false,
    });

    if (mode === "season" && revealed) {
      drawText(ctx, `${e.points} pts`, nameX, midY + 22, {
        size: 26,
        weight: "700",
        color: "rgba(255,255,255,.55)",
        align: "left",
        shadow: false,
      });
      drawDeltaBadge(ctx, e.delta, W - padX - 170, midY);
    }

    if (isCurrent && (slotLocal || 0) < 0.85) {
      ctx.strokeStyle = `rgba(255,255,255,${0.4 * (1 - (slotLocal || 0) / 0.85)})`;
      ctx.lineWidth = 4;
      roundRect(ctx, padX, y + 8, W - padX * 2, rowH - 16, 22);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawText(ctx, footer || "National anthem · 5s each", W / 2, H - 70, {
    size: 26,
    weight: "700",
    color: "rgba(255,255,255,.45)",
    shadow: false,
  });
}

async function prepareEntries(rows) {
  const top = rows.slice(0, COUNT);
  const imgs = await Promise.all(
    top.map((r) =>
      loadImage(r.img || `https://flagcdn.com/w160/${String(r.code || "").toLowerCase()}.png`)
    )
  );
  return top.map((r, i) => ({
    ...r,
    rank: Number(r.rank) || i + 1,
    img: imgs[i],
  }));
}

async function loadAnthems(revealEntries, audioCtx, apiBase, onProgress) {
  const out = [];
  for (let i = 0; i < revealEntries.length; i++) {
    const e = revealEntries[i];
    reportProgress(
      onProgress,
      `Anthem ${i + 1}/${revealEntries.length}`,
      i / Math.max(1, revealEntries.length)
    );
    let buf = await loadAnthemBuffer(e.code, audioCtx, apiBase);
    if (!buf) buf = makeFanfareBuffer(audioCtx, e.rank);
    out.push(buf);
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
  headline,
  subtitle,
  entries,
  apiBase = "",
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

  const revealEntries = [...entries].reverse(); // #10 → #1

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio API is not available.");
  const audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const dest = audioCtx.createMediaStreamDestination();

  reportProgress(onProgress, "Loading anthems", 0.02);
  const anthemBufs = await loadAnthems(revealEntries, audioCtx, apiBase, onProgress);

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
  while (true) {
    const t = (performance.now() - t0) / 1000;
    if (t >= TOTAL) break;

    if (t < INTRO) {
      drawIntroFrame(ctx, t, headline, subtitle);
    } else {
      const elapsed = t - INTRO;
      const revealIndex = Math.min(COUNT - 1, Math.floor(elapsed / SLOT));
      const slotLocal = elapsed - revealIndex * SLOT;
      const revealRank = COUNT - revealIndex; // 10,9,...,1
      const playing = revealEntries[revealIndex];
      drawBoardFrame(ctx, {
        t,
        headline,
        subtitle,
        entries,
        mode,
        revealRank,
        slotLocal,
        footer: playing
          ? `♪ ${playing.name} · national anthem`
          : "National anthem · 5s each",
      });
    }

    reportProgress(onProgress, "Recording", t / TOTAL);
    await sleep(1000 / FPS);
  }

  // Final hold: all revealed
  drawBoardFrame(ctx, {
    t: TOTAL,
    headline,
    subtitle,
    entries,
    mode,
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
  const apiBase = opts.apiBase || "";
  return recordTop10Short({
    mode: "final",
    headline: "FINAL TOP 10",
    subtitle: formatWhen(stream.endedAt || stream.startedAt) || "Stream Final",
    entries,
    apiBase,
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
  const apiBase = opts.apiBase || "";
  return recordTop10Short({
    mode: "season",
    headline: "SEASON TOP 10",
    subtitle: "Points ranking · ↑ gained · ↓ lost",
    entries,
    apiBase,
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
