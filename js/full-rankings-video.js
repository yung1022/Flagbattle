/**
 * Landscape (16:9) full battle rankings video — every country in one board.
 * Shows battle place + average qualifying-round place when available.
 * Encodes faster than realtime via MediaStreamTrackGenerator + VideoFrame
 * timestamps (falls back to a short wall-clock capture if unavailable).
 */

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
/** Hold long enough to read; encode is still near-instant with track generator. */
const DURATION_SEC = 12;
const COLS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
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

function pickMime() {
  const candidates = [
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

/**
 * Resolve a battle from an explicit battle, a Final stream + history, or streams list.
 * @param {object} opts
 * @param {object} [opts.battle]
 * @param {object} [opts.stream] finished Final (paired with prior qualifying when possible)
 * @param {Array} [opts.streams] full rankings history for pairing
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
  return battles.filter((b) => b.ended || b.final?.final?.ranking?.length).at(-1) || null;
}

/**
 * @param {object} battle
 * @returns {Array<{
 *   code: string,
 *   name: string,
 *   place: number,
 *   avgQual: number|null,
 *   finalist: boolean,
 *   img: CanvasImageSource|null,
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
      imgUrl: flagUrl(c.code, 40),
    });
  }
  rows.sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
  return rows;
}

async function preloadFlags(rows, onProgress) {
  const batch = 32;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const imgs = await Promise.all(slice.map((r) => loadImage(r.imgUrl)));
    slice.forEach((r, j) => {
      r.img = imgs[j];
    });
    reportProgress(
      onProgress,
      `Flags ${Math.min(i + batch, rows.length)}/${rows.length}`,
      0.05 + 0.35 * ((i + batch) / rows.length)
    );
  }
}

function formatAvg(avg) {
  if (avg == null || !Number.isFinite(avg)) return "—";
  return avg < 10 ? avg.toFixed(1) : String(Math.round(avg * 10) / 10);
}

function paintBoard(ctx, { rows, battle, channelName, t }) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0d1c28");
  bg.addColorStop(0.55, "#08131c");
  bg.addColorStop(1, "#050b11");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const pulse = 0.06 + 0.03 * Math.sin(t * 2.2);
  const glow = ctx.createRadialGradient(W * 0.5, 80, 20, W * 0.5, 120, 520);
  glow.addColorStop(0, `rgba(230,184,74,${pulse})`);
  glow.addColorStop(1, "rgba(230,184,74,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 52px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("FLAG BATTLE", 48, 44);

  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 28px "Manrope", system-ui, sans-serif';
  ctx.fillText("FULL RANKINGS", 320, 46);

  const when = battle?.startedAt ? new Date(battle.startedAt) : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";
  const winner = battle?.winner?.name || battle?.final?.final?.winner?.name || "";
  const finalists = battle?.final?.final?.ranking?.length || 0;
  const sub = [
    whenLabel,
    winner ? `Winner · ${winner}` : "",
    finalists ? `${finalists} finalists` : "",
    `${rows.length} countries`,
  ]
    .filter(Boolean)
    .join("   ·   ");

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '600 18px "Manrope", system-ui, sans-serif';
  ctx.fillText(sub, 48, 84);

  // Column legend strip
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(40, 108, W - 80, 28);
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 13px "Manrope", system-ui, sans-serif';
  ctx.fillText("PLACE  ·  COUNTRY  ·  AVG QUALIFYING PLACE", 52, 122);

  const top = 148;
  const bottom = H - 58;
  const boardH = bottom - top;
  const boardW = W - 64;
  const colW = boardW / COLS;
  const rowsPerCol = Math.ceil(rows.length / COLS);
  const rowH = Math.min(22, boardH / Math.max(1, rowsPerCol));

  for (let i = 0; i < rows.length; i++) {
    const col = Math.floor(i / rowsPerCol);
    const row = i % rowsPerCol;
    const x = 32 + col * colW;
    const y = top + row * rowH;
    const entry = rows[i];
    const zebra = row % 2 === 0;

    if (zebra) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(x, y, colW - 8, rowH);
    }

    // Place
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = entry.finalist ? "#e6b84a" : "#7f96a8";
    ctx.font = '800 14px "Manrope", system-ui, sans-serif';
    ctx.fillText(String(entry.place), x + 36, y + rowH / 2);

    // Flag
    const fx = x + 44;
    const fy = y + (rowH - 12) / 2;
    if (entry.img) {
      roundRectPath(ctx, fx, fy, 18, 12, 2);
      ctx.save();
      ctx.clip();
      ctx.drawImage(entry.img, fx, fy, 18, 12);
      ctx.restore();
    } else {
      ctx.fillStyle = "#2a4050";
      ctx.fillRect(fx, fy, 18, 12);
    }

    // Name
    ctx.textAlign = "left";
    ctx.fillStyle = entry.finalist ? "#f4f7fa" : "#c5d3de";
    ctx.font = `${entry.finalist ? "700" : "600"} 13px "Manrope", system-ui, sans-serif`;
    const nameMax = colW - 140;
    let name = entry.name;
    while (name.length > 3 && ctx.measureText(name).width > nameMax) {
      name = name.slice(0, -2);
    }
    if (name !== entry.name) name = `${name}…`;
    ctx.fillText(name, x + 68, y + rowH / 2);

    // Avg qualifying
    ctx.textAlign = "right";
    ctx.fillStyle = entry.avgQual != null ? "#2ec4b6" : "#5a7080";
    ctx.font = '700 12px "Manrope", system-ui, sans-serif';
    ctx.fillText(formatAvg(entry.avgQual), x + colW - 16, y + rowH / 2);
  }

  // Footer
  ctx.textAlign = "left";
  ctx.fillStyle = "#5a7080";
  ctx.font = '600 14px "Manrope", system-ui, sans-serif';
  ctx.fillText(
    "Gold place = Finalist   ·   Avg = mean place across qualifying rounds",
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

/**
 * Encode canvas frames faster than realtime with correct duration.
 * Prefers WebCodecs + webm-muxer; falls back to MediaStreamTrackGenerator,
 * then short wall-clock MediaRecorder.
 */
async function recordFramesFast(canvas, frameCount, fps, paint, onProgress) {
  const mimeType = "video/webm";
  const durationSec = frameCount / fps;
  const frameDurUs = Math.round(1_000_000 / fps);

  // 1) WebCodecs + muxer (fast + correct timestamps)
  if (typeof VideoEncoder === "function" && typeof VideoFrame === "function") {
    try {
      const { Muxer, ArrayBufferTarget } = await import(
        "https://esm.sh/webm-muxer@5.0.2"
      );
      const codecCandidates = [
        { mux: "V_VP9", enc: "vp09.00.10.08" },
        { mux: "V_VP8", enc: "vp8" },
      ];
      let chosen = null;
      for (const c of codecCandidates) {
        if (await VideoEncoder.isConfigSupported?.({
          codec: c.enc,
          width: canvas.width,
          height: canvas.height,
          bitrate: 8_000_000,
          framerate: fps,
        }).then((r) => r?.supported).catch(() => false)) {
          chosen = c;
          break;
        }
      }
      if (chosen) {
        const target = new ArrayBufferTarget();
        const muxer = new Muxer({
          target,
          video: {
            codec: chosen.mux,
            width: canvas.width,
            height: canvas.height,
            frameRate: fps,
          },
        });
        let encError = null;
        const encoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (e) => {
            encError = e;
          },
        });
        encoder.configure({
          codec: chosen.enc,
          width: canvas.width,
          height: canvas.height,
          bitrate: 8_000_000,
          framerate: fps,
        });

        for (let i = 0; i < frameCount; i++) {
          paint(i / fps);
          const frame = new VideoFrame(canvas, {
            timestamp: i * frameDurUs,
            duration: frameDurUs,
          });
          encoder.encode(frame, { keyFrame: i % fps === 0 });
          frame.close();
          while (encoder.encodeQueueSize > 10) await sleep(0);
          if (i % 10 === 0) {
            reportProgress(onProgress, "Encoding", 0.45 + 0.5 * (i / frameCount));
            await sleep(0);
          }
          if (encError) throw encError;
        }
        await encoder.flush();
        encoder.close();
        muxer.finalize();
        const blob = new Blob([target.buffer], { type: mimeType });
        if (blob.size) {
          return { blob, mimeType, durationSec };
        }
      }
    } catch (err) {
      console.warn("WebCodecs fast encode failed, falling back:", err);
    }
  }

  // 2) Insertable Streams + MediaRecorder
  const canTrackGen =
    typeof MediaStreamTrackGenerator === "function" &&
    typeof VideoFrame === "function";
  if (canTrackGen) {
    try {
      const recorderMime = pickMime();
      const generator = new MediaStreamTrackGenerator({ kind: "video" });
      const writer = generator.writable.getWriter();
      const stream = new MediaStream([generator]);
      const recorder = new MediaRecorder(stream, {
        mimeType: recorderMime,
        videoBitsPerSecond: 10_000_000,
      });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data?.size) chunks.push(e.data);
      };
      const doneRec = new Promise((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () =>
          reject(recorder.error || new Error("Recording failed"));
      });
      recorder.start(100);

      for (let i = 0; i < frameCount; i++) {
        paint(i / fps);
        const frame = new VideoFrame(canvas, {
          timestamp: i * frameDurUs,
          duration: frameDurUs,
        });
        await writer.write(frame);
        frame.close();
        if (i % 8 === 0) {
          reportProgress(onProgress, "Encoding", 0.45 + 0.5 * (i / frameCount));
          await sleep(0);
        }
      }

      recorder.stop();
      try {
        await writer.close();
      } catch {
        /* ignore */
      }
      generator.stop?.();
      await doneRec;
      stream.getTracks().forEach((tr) => tr.stop());

      const blob = new Blob(chunks, {
        type: recorderMime.includes("webm") ? "video/webm" : recorderMime,
      });
      if (blob.size) {
        return { blob, mimeType: recorderMime, durationSec };
      }
    } catch (err) {
      console.warn("TrackGenerator encode failed, falling back:", err);
    }
  }

  // 3) Wall-clock MediaRecorder (short clip — still only ~DURATION_SEC)
  const recorderMime = pickMime();
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: recorderMime,
    videoBitsPerSecond: 10_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };
  const doneRec = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () =>
      reject(recorder.error || new Error("Recording failed"));
  });
  recorder.start(100);
  const t0 = performance.now();
  const frameMs = 1000 / fps;
  for (let i = 0; i < frameCount; i++) {
    paint(i / fps);
    reportProgress(onProgress, "Recording", 0.45 + 0.5 * (i / frameCount));
    const target = t0 + (i + 1) * frameMs;
    const wait = target - performance.now();
    if (wait > 8) await sleep(wait);
    else await nextFrame();
  }
  recorder.stop();
  await doneRec;
  stream.getTracks().forEach((tr) => tr.stop());
  const blob = new Blob(chunks, {
    type: recorderMime.includes("webm") ? "video/webm" : recorderMime,
  });
  return { blob, mimeType: recorderMime, durationSec };
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
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }
  if (document.fonts?.ready) await document.fonts.ready;

  reportProgress(opts.onProgress, "Building ranks", 0.02);
  const battle = resolveBattle(opts);
  if (!battle) throw new Error("No finished battle to rank.");

  const rows = buildFullRankingRows(battle);
  if (!rows.length) throw new Error("No ranking rows for this battle.");

  await preloadFlags(rows, opts.onProgress);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");

  const frameCount = Math.ceil(DURATION_SEC * FPS);
  reportProgress(opts.onProgress, "Encoding", 0.42);

  const { blob, mimeType, durationSec } = await recordFramesFast(
    canvas,
    frameCount,
    FPS,
    (t) =>
      paintBoard(ctx, {
        rows,
        battle,
        channelName: opts.channelName,
        t,
      }),
    opts.onProgress
  );

  if (!blob.size) throw new Error("Recording produced an empty file.");
  reportProgress(opts.onProgress, "Done", 1);

  return {
    blob,
    mimeType,
    durationSec,
    mode: "full-rankings",
    width: W,
    height: H,
    rows: rows.length,
    winner: battle.winner
      ? { code: battle.winner.code, name: battle.winner.name }
      : null,
  };
}
