/**
 * Generate a vertical (~9:16) highlight Short from a finished Final ranking.
 * Uses Canvas + MediaRecorder (no OBS). Suitable for YouTube Shorts upload.
 */

const W = 1080;
const H = 1920;
const FPS = 30;

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function ensureFonts() {
  if (document.fonts?.ready) await document.fonts.ready;
}

function pickMime() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const t of types) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return "";
}

/**
 * @param {object} stream finished stream with final.ranking
 * @param {object} [opts]
 * @param {(p:{phase:string,progress:number})=>void} [opts.onProgress]
 * @returns {Promise<{blob:Blob, mimeType:string, durationSec:number}>}
 */
export async function generateHighlightShort(stream, opts = {}) {
  const ranking = stream?.final?.ranking;
  if (!Array.isArray(ranking) || !ranking.length) {
    throw new Error("Stream has no Final ranking yet");
  }
  if (!window.MediaRecorder) {
    throw new Error("MediaRecorder not supported in this browser");
  }
  const mimeType = pickMime();
  if (!mimeType) throw new Error("No supported video MIME type for MediaRecorder");

  await ensureFonts();
  const onProgress = opts.onProgress || (() => {});

  const top = ranking.slice(0, 15);
  const champion = ranking[0];
  const flags = await Promise.all(
    ranking.map((r) =>
      loadImage(r.img || `https://flagcdn.com/w160/${r.code}.png`)
    )
  );
  const flagByCode = new Map(ranking.map((r, i) => [r.code, flags[i]]));

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const streamOut = canvas.captureStream(FPS);

  // Silent audio track helps some YouTube ingest paths.
  let audioCtx = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      audioCtx = new AC();
      const dest = audioCtx.createMediaStreamDestination();
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      g.gain.value = 0.0001;
      osc.connect(g);
      g.connect(dest);
      osc.start();
      dest.stream.getAudioTracks().forEach((t) => streamOut.addTrack(t));
    }
  } catch {
    /* ignore */
  }

  const chunks = [];
  const recorder = new MediaRecorder(streamOut, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  const durationSec = Math.min(58, 12 + Math.min(ranking.length, 40) * 0.9);
  const totalFrames = Math.round(durationSec * FPS);

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      try {
        audioCtx?.close?.();
      } catch {
        /* ignore */
      }
      resolve(
        new Blob(chunks, { type: mimeType.includes("mp4") ? "video/mp4" : "video/webm" })
      );
    };
    recorder.onerror = () => reject(new Error("MediaRecorder failed"));
  });

  recorder.start(200);

  // Advance canvas in real time so captureStream records ~durationSec.
  const frameMs = 1000 / FPS;
  const startedAt = performance.now();
  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / FPS;
    const progress = frame / totalFrames;
    drawFrame(ctx, {
      t,
      progress,
      durationSec,
      ranking,
      top,
      champion,
      flagByCode,
      stream,
    });
    if (frame % 6 === 0) {
      onProgress({
        phase: phaseName(t, durationSec),
        progress,
      });
    }
    const target = startedAt + (frame + 1) * frameMs;
    const wait = target - performance.now();
    if (wait > 8) await sleep(wait);
    else await nextFrame();
  }

  onProgress({ phase: "finishing", progress: 1 });
  recorder.stop();
  streamOut.getTracks().forEach((tr) => tr.stop());
  const blob = await stopped;
  return { blob, mimeType: blob.type, durationSec };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function phaseName(t, dur) {
  if (t < 3.2) return "intro";
  if (t < dur * 0.42) return "final highlights";
  if (t < dur * 0.82) return "full ranking";
  return "champion";
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function drawFrame(ctx, state) {
  const { t, durationSec, ranking, top, champion, flagByCode, stream } = state;
  const introEnd = 3.2;
  const highlightEnd = durationSec * 0.42;
  const resultsEnd = durationSec * 0.82;

  paintBg(ctx, t);

  if (t < introEnd) {
    drawIntro(ctx, t / introEnd, stream, champion);
  } else if (t < highlightEnd) {
    const u = (t - introEnd) / (highlightEnd - introEnd);
    drawHighlights(ctx, u, ranking, flagByCode);
  } else if (t < resultsEnd) {
    const u = (t - highlightEnd) / (resultsEnd - highlightEnd);
    drawFullRanking(ctx, u, ranking, flagByCode);
  } else {
    const u = (t - resultsEnd) / Math.max(0.01, durationSec - resultsEnd);
    drawChampion(ctx, u, champion, flagByCode.get(champion.code), ranking.length);
  }

  // Footer brand
  ctx.fillStyle = "rgba(109,132,150,0.9)";
  ctx.font = '600 22px "Manrope", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FLAG BATTLE · Final Results", W / 2, H - 40);
}

function paintBg(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0c1c28");
  g.addColorStop(0.5, "#071018");
  g.addColorStop(1, "#050b11");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const pulse = 0.15 + 0.05 * Math.sin(t * 2);
  const glow = ctx.createRadialGradient(W / 2, 220, 20, W / 2, 280, 700);
  glow.addColorStop(0, `rgba(46,196,182,${pulse})`);
  glow.addColorStop(1, "rgba(46,196,182,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawIntro(ctx, u, stream, champion) {
  const fade = Math.min(1, u * 2);
  ctx.globalAlpha = fade;
  ctx.fillStyle = "#f4f7fa";
  ctx.font = '700 86px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FLAG BATTLE", W / 2, 520);

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 110px "Bebas Neue", Impact, sans-serif';
  ctx.fillText("FINAL RESULTS", W / 2, 660);

  const when = stream.startedAt
    ? new Date(stream.startedAt).toLocaleString()
    : "";
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 32px "Manrope", sans-serif';
  ctx.fillText(when, W / 2, 740);

  if (champion && u > 0.45) {
    ctx.globalAlpha = Math.min(1, (u - 0.45) / 0.4);
    ctx.fillStyle = "#2ec4b6";
    ctx.font = '700 40px "Manrope", sans-serif';
    ctx.fillText(`Champion · ${champion.name}`, W / 2, 860);
  }
  ctx.globalAlpha = 1;
}

function drawHighlights(ctx, u, ranking, flagByCode) {
  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 64px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FINAL BATTLE", W / 2, 160);
  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 28px "Manrope", sans-serif';
  ctx.fillText("Last Flag Standing · highlights", W / 2, 210);

  // Show dramatic reverse: late eliminations → approaching #1
  const n = Math.min(ranking.length, 24);
  const slice = ranking.slice(0, n);
  const idx = Math.min(n - 1, Math.floor(u * n));
  // Walk from last place in slice toward first
  const focus = slice[n - 1 - idx];
  const flag = flagByCode.get(focus.code);

  roundRectFill(ctx, 80, 320, W - 160, 720, 24, "rgba(18,36,51,0.85)");
  ctx.strokeStyle = "rgba(230,184,74,0.4)";
  ctx.lineWidth = 3;
  roundRectPath(ctx, 80, 320, W - 160, 720, 24);
  ctx.stroke();

  if (flag) {
    ctx.drawImage(flag, W / 2 - 160, 380, 320, 214);
  }
  ctx.fillStyle =
    focus.rank === 1 ? "#ffd978" : focus.rank <= 3 ? "#e6b84a" : "#f4f7fa";
  ctx.font = '700 120px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(`#${focus.rank}`, W / 2, 700);
  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 54px "Manrope", sans-serif';
  ctx.fillText(focus.name, W / 2, 780);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 28px "Manrope", sans-serif';
  ctx.fillText(
    focus.rank === 1 ? "LAST FLAG STANDING" : "Eliminated in the Final",
    W / 2,
    860
  );

  // Mini strip of upcoming / recent
  const stripY = 1120;
  for (let i = 0; i < 5; i++) {
    const r = slice[Math.max(0, n - 1 - idx - 2 + i)];
    if (!r) continue;
    const x = 100 + i * 180;
    const f = flagByCode.get(r.code);
    if (f) ctx.drawImage(f, x, stripY, 120, 80);
    ctx.fillStyle = r.code === focus.code ? "#e6b84a" : "#6d8496";
    ctx.font = '700 26px "Bebas Neue", Impact, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(`#${r.rank}`, x + 60, stripY + 120);
  }
}

function drawFullRanking(ctx, u, ranking, flagByCode) {
  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 64px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FULL FINAL RANKING", W / 2, 150);

  const rowH = 86;
  const visible = 16;
  const maxScroll = Math.max(0, ranking.length - visible);
  const scroll = u * maxScroll;
  const start = Math.floor(scroll);
  const frac = scroll - start;
  const y0 = 220 - frac * rowH;

  for (let i = 0; i < visible + 1; i++) {
    const row = ranking[start + i];
    if (!row) continue;
    const y = y0 + i * rowH;
    if (y < 180 || y > H - 120) continue;
    const podium = row.rank <= 3;
    roundRectFill(
      ctx,
      60,
      y,
      W - 120,
      rowH - 10,
      10,
      podium ? "rgba(230,184,74,0.1)" : "rgba(18,36,51,0.75)"
    );
    ctx.fillStyle =
      row.rank === 1
        ? "#ffd978"
        : row.rank === 2
          ? "#c5d0da"
          : row.rank === 3
            ? "#d08b5a"
            : "#2ec4b6";
    ctx.font = '700 48px "Bebas Neue", Impact, sans-serif';
    ctx.textAlign = "left";
    ctx.fillText(`#${row.rank}`, 84, y + 52);

    const f = flagByCode.get(row.code);
    if (f) ctx.drawImage(f, 200, y + 14, 72, 48);

    ctx.fillStyle = "#f4f7fa";
    ctx.font = '800 34px "Manrope", sans-serif';
    ctx.fillText(truncate(ctx, row.name, 620), 292, y + 52);
  }
}

function drawChampion(ctx, u, champion, flag, fieldSize) {
  const fade = Math.min(1, u * 3);
  ctx.globalAlpha = fade;
  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 72px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("CHAMPION", W / 2, 360);

  if (flag) {
    const scale = 0.9 + 0.08 * Math.sin(u * Math.PI * 4);
    const fw = 420 * scale;
    const fh = 280 * scale;
    ctx.drawImage(flag, W / 2 - fw / 2, 420, fw, fh);
  }

  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 70px "Manrope", sans-serif';
  ctx.fillText(champion?.name || "—", W / 2, 820);

  ctx.fillStyle = "#2ec4b6";
  ctx.font = '700 36px "Manrope", sans-serif';
  ctx.fillText("Last Flag Standing", W / 2, 890);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 28px "Manrope", sans-serif';
  ctx.fillText(`${fieldSize} finalists`, W / 2, 960);
  ctx.globalAlpha = 1;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function roundRectFill(ctx, x, y, w, h, r, fill) {
  ctx.fillStyle = fill;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
