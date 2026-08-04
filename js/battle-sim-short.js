/**
 * One-round hole-circle FLAG BATTLE simulation Short (9:16).
 * Last flag standing wins. Physics mirrors js/game.js qualifying round.
 */

import { loadAnthemBuffer, makeFanfareBuffer } from "./anthem.js";
import { COUNTRIES, flagUrl } from "./countries.js";

const W = 1080;
const H = 1920;
const FPS = 30;
const HOLD_WIN_SEC = 6;
/** Soft cap so a Short cannot run forever if one flag never falls. */
const MAX_BATTLE_SEC = 90;

/** Match live qualifying physics in js/game.js CONFIG (real-time, not sped up). */
const SIM = {
  arenaRadius: 0.42,
  holeWidth: 0.85,
  holeSpeed: 1.8,
  maxSpeed: 1.15,
  pushStrength: 0.8,
  outwardForce: 0.35,
  shrinkMinScale: 0.68,
  shrinkDurationSec: 40,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normAngle(a) {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x;
}

function angleDiff(a, b) {
  let d = normAngle(a) - normAngle(b);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function flagSizeForCount(count) {
  const n = Math.max(1, count);
  const radius = Math.min(0.034, Math.max(0.011, 0.2 / Math.sqrt(n)));
  const px = Math.min(64, Math.max(14, 520 / Math.sqrt(n)));
  return { radius, px };
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

function makeFighter(country, index, total) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
  const radius = 0.05 + Math.random() * SIM.arenaRadius * 0.62;
  const speed = SIM.maxSpeed * (0.45 + Math.random() * 0.55);
  const dir = Math.random() * Math.PI * 2;
  return {
    code: country.code,
    name: country.name,
    imgUrl: flagUrl(country.code, 80),
    img: null,
    alive: true,
    falling: false,
    x: 0.5 + Math.cos(angle) * radius,
    y: 0.5 + Math.sin(angle) * radius,
    vx: Math.cos(dir) * speed,
    vy: Math.sin(dir) * speed,
  };
}

function createSim(countries) {
  const list = shuffle(countries);
  return {
    fighters: list.map((c, i) => makeFighter(c, i, list.length)),
    holeAngle: Math.random() * Math.PI * 2,
    arenaScale: 1,
    elapsed: 0,
    winner: null,
    done: false,
  };
}

function standing(sim) {
  return sim.fighters.filter((f) => f.alive && !f.falling);
}

function alive(sim) {
  return sim.fighters.filter((f) => f.alive);
}

function flagRadius(sim) {
  return flagSizeForCount(standing(sim).length || sim.fighters.length || 1).radius;
}

function stepSim(sim, dt) {
  if (sim.done) return;

  sim.elapsed += dt;
  const t = Math.min(1, sim.elapsed / SIM.shrinkDurationSec);
  sim.arenaScale = 1 - (1 - SIM.shrinkMinScale) * (t * t);

  const stand = standing(sim);
  const packBoost = 1 + Math.min(1.4, stand.length / 100);
  const lateBoost = 1 + t * 1.1;
  sim.holeAngle = normAngle(
    sim.holeAngle + SIM.holeSpeed * packBoost * lateBoost * dt
  );

  moveFighters(sim, dt);
  resolveCollisions(sim);
  applyCircleAndHole(sim, t);

  const standNow = standing(sim);
  const aliveNow = alive(sim);
  if (standNow.length === 1) {
    for (const f of sim.fighters) {
      if (f.falling && f.alive) markFallen(sim, f);
    }
    sim.winner = standNow[0];
    sim.done = true;
  } else if (aliveNow.length === 0) {
    // Extreme edge case — pick last fallen as winner.
    const last = sim.fighters.filter((f) => !f.alive).slice(-1)[0];
    sim.winner = last || sim.fighters[0];
    sim.done = true;
  } else if (sim.elapsed >= MAX_BATTLE_SEC) {
    // Time cap: closest to center among standing wins.
    const pool = standNow.length ? standNow : aliveNow;
    pool.sort(
      (a, b) =>
        Math.hypot(a.x - 0.5, a.y - 0.5) - Math.hypot(b.x - 0.5, b.y - 0.5)
    );
    sim.winner = pool[0];
    sim.done = true;
  }
}

function moveFighters(sim, dt) {
  for (const f of sim.fighters) {
    if (!f.alive) continue;
    if (f.falling) {
      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const len = Math.hypot(dx, dy) || 1;
      f.vx += (dx / len) * 1.4 * dt;
      f.vy += (dy / len) * 1.4 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (Math.hypot(f.x - 0.5, f.y - 0.5) > 0.8) markFallen(sim, f);
      continue;
    }

    const dx = f.x - 0.5;
    const dy = f.y - 0.5;
    const len = Math.hypot(dx, dy) || 1;
    f.vx += (dx / len) * SIM.outwardForce * dt;
    f.vy += (dy / len) * SIM.outwardForce * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;

    const speed = Math.hypot(f.vx, f.vy);
    if (speed > SIM.maxSpeed) {
      f.vx = (f.vx / speed) * SIM.maxSpeed;
      f.vy = (f.vy / speed) * SIM.maxSpeed;
    } else if (speed < 0.2) {
      const dir = Math.random() * Math.PI * 2;
      f.vx += Math.cos(dir) * 0.15;
      f.vy += Math.sin(dir) * 0.15;
    }

    f.x = Math.max(-0.1, Math.min(1.1, f.x));
    f.y = Math.max(-0.1, Math.min(1.1, f.y));
  }
}

function resolveCollisions(sim) {
  const active = sim.fighters.filter((f) => f.alive && !f.falling);
  const n = active.length;
  if (n < 2) return;
  const minDist = flagRadius(sim) * 2.05;
  const minSq = minDist * minDist;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = active[i];
      const B = active[j];
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minSq || distSq === 0) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = (minDist - dist) * 0.5;
      A.x -= nx * overlap;
      A.y -= ny * overlap;
      B.x += nx * overlap;
      B.y += ny * overlap;
      const avn = A.vx * nx + A.vy * ny;
      const bvn = B.vx * nx + B.vy * ny;
      const exchange = (avn - bvn) * SIM.pushStrength;
      A.vx -= exchange * nx;
      A.vy -= exchange * ny;
      B.vx += exchange * nx;
      B.vy += exchange * ny;
    }
  }
}

function applyCircleAndHole(sim, roundProgress) {
  const R = SIM.arenaRadius * sim.arenaScale;
  const fr = flagRadius(sim);
  // Same half-hole growth as js/game.js applyCircleAndHole.
  const holeHalf = (SIM.holeWidth * (1 + roundProgress * 0.65)) / 2;

  for (const f of sim.fighters) {
    if (!f.alive || f.falling) continue;
    const dx = f.x - 0.5;
    const dy = f.y - 0.5;
    const dist = Math.hypot(dx, dy) || 0.0001;
    if (dist < R - fr) continue;

    const ang = Math.atan2(dy, dx);
    const inHole = Math.abs(angleDiff(ang, sim.holeAngle)) <= holeHalf;
    if (inHole) {
      f.falling = true;
      const nx = dx / dist;
      const ny = dy / dist;
      f.vx += nx * 0.55;
      f.vy += ny * 0.55;
    } else {
      const nx = dx / dist;
      const ny = dy / dist;
      f.x = 0.5 + nx * (R - fr);
      f.y = 0.5 + ny * (R - fr);
      const vn = f.vx * nx + f.vy * ny;
      if (vn > 0) {
        f.vx -= vn * nx * 1.4;
        f.vy -= vn * ny * 1.4;
      }
      // Tangential nudge toward hole
      const tangent = Math.sign(angleDiff(sim.holeAngle, ang)) || 1;
      f.vx += -ny * tangent * 0.12;
      f.vy += nx * tangent * 0.12;
    }
  }
}

function markFallen(sim, f) {
  if (!f.alive) return;
  f.alive = false;
  f.falling = false;
}

function arenaLayout() {
  const size = Math.min(W - 80, H * 0.62);
  const x = (W - size) / 2;
  const y = 210;
  return { x, y, size, cx: x + size / 2, cy: y + size / 2 };
}

function paintFrame(ctx, sim, { channelName, phaseLabel }) {
  // Atmosphere
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0c1c28");
  bg.addColorStop(0.55, "#071018");
  bg.addColorStop(1, "#050b11");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const pulse = 0.1 + 0.04 * Math.sin(sim.elapsed * 2);
  const glow = ctx.createRadialGradient(W / 2, 420, 40, W / 2, 500, 700);
  glow.addColorStop(0, `rgba(46,196,182,${pulse})`);
  glow.addColorStop(1, "rgba(46,196,182,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#e6b84a";
  ctx.font = '700 56px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FLAG BATTLE", W / 2, 78);

  ctx.fillStyle = "#8fa6b8";
  ctx.font = '700 26px "Manrope", system-ui, sans-serif';
  ctx.fillText(phaseLabel || "ONE ROUND · LAST FLAG STANDING", W / 2, 130);

  const { x, y, size, cx, cy } = arenaLayout();
  const rimR = SIM.arenaRadius * sim.arenaScale * size;

  // Arena disc
  ctx.beginPath();
  ctx.arc(cx, cy, rimR + 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(12,28,40,0.9)";
  ctx.fill();

  // Rim
  ctx.beginPath();
  ctx.arc(cx, cy, rimR, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(46,196,182,0.85)";
  ctx.lineWidth = 10;
  ctx.stroke();

  // Hole gap (same formula as physics)
  const roundProgress = Math.min(1, sim.elapsed / SIM.shrinkDurationSec);
  const holeHalf = (SIM.holeWidth * (1 + roundProgress * 0.65)) / 2;
  ctx.beginPath();
  ctx.strokeStyle = "#071018";
  ctx.lineWidth = 14;
  ctx.arc(cx, cy, rimR, sim.holeAngle - holeHalf, sim.holeAngle + holeHalf);
  ctx.stroke();

  // Inner floor
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(8, rimR - 6), 0, Math.PI * 2);
  ctx.fillStyle = "rgba(18,40,56,0.95)";
  ctx.fill();

  const standN = standing(sim).length;
  const frPx = flagSizeForCount(standN || 1).px;

  for (const f of sim.fighters) {
    if (!f.alive && !f.falling) continue;
    const px = x + f.x * size;
    const py = y + f.y * size;
    const alpha = f.falling ? 0.55 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (f.img) {
      const fw = frPx;
      const fh = frPx * 0.66;
      roundRectPath(ctx, px - fw / 2, py - fh / 2, fw, fh, 6);
      ctx.clip();
      ctx.drawImage(f.img, px - fw / 2, py - fh / 2, fw, fh);
    } else {
      ctx.fillStyle = "#2ec4b6";
      ctx.beginPath();
      ctx.arc(px, py, frPx * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // HUD
  ctx.fillStyle = "#f4f7fa";
  ctx.font = '800 34px "Manrope", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(`${standN} LEFT`, W / 2, y + size + 48);

  if (sim.done && sim.winner) {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);
    const w = sim.winner;
    ctx.fillStyle = "#ffd978";
    ctx.font = '700 64px "Bebas Neue", Impact, sans-serif';
    ctx.fillText("WINNER", W / 2, H * 0.38);
    if (w.img) {
      const fw = 280;
      const fh = 186;
      ctx.drawImage(w.img, W / 2 - fw / 2, H * 0.42, fw, fh);
    }
    ctx.fillStyle = "#f4f7fa";
    ctx.font = '800 48px "Manrope", system-ui, sans-serif';
    ctx.fillText(String(w.name || "").toUpperCase(), W / 2, H * 0.58);
  }

  // Channel footer
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#ffffff";
  ctx.font = '900 64px "Bebas Neue", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(
    String(channelName || "FLAG BATTLE").toUpperCase().slice(0, 28),
    W / 2,
    H - 70,
    W - 80
  );
  ctx.restore();
}

async function preloadFlags(fighters, onProgress) {
  const batch = 24;
  for (let i = 0; i < fighters.length; i += batch) {
    const slice = fighters.slice(i, i + batch);
    const imgs = await Promise.all(slice.map((f) => loadImage(f.imgUrl)));
    slice.forEach((f, j) => {
      f.img = imgs[j];
    });
    reportProgress(
      onProgress,
      `Flags ${Math.min(i + batch, fighters.length)}/${fighters.length}`,
      (i + batch) / fighters.length
    );
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.channelName]
 * @param {(p:{phase:string,progress:number})=>void} [opts.onProgress]
 * @param {number} [opts.count] roster size (default all countries)
 */
export async function generateBattleSimShort(opts = {}) {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }
  if (document.fonts?.ready) await document.fonts.ready;

  const count = Math.max(
    8,
    Math.min(COUNTRIES.length, Number(opts.count) || COUNTRIES.length)
  );
  const roster = shuffle(COUNTRIES).slice(0, count);
  const sim = createSim(roster);

  reportProgress(opts.onProgress, "Loading flags", 0.02);
  await preloadFlags(sim.fighters, opts.onProgress);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioCtx ? new AudioCtx() : null;
  if (audioCtx?.state === "suspended") await audioCtx.resume();
  const dest = audioCtx?.createMediaStreamDestination?.() || null;

  const stream = canvas.captureStream(FPS);
  if (dest) {
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
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
  const doneRec = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(recorder.error || new Error("Recording failed"));
  });

  reportProgress(opts.onProgress, "Recording battle", 0.08);
  recorder.start(200);

  const dt = 1 / FPS;
  const frameMs = 1000 / FPS;
  const t0 = performance.now();
  let frames = 0;
  const maxBattleFrames = Math.ceil(MAX_BATTLE_SEC * FPS);

  /** Keep MediaRecorder wall-clock in lockstep with FPS (1 sim second = 1 video second). */
  async function waitForFrame() {
    frames += 1;
    const target = t0 + frames * frameMs;
    const wait = target - performance.now();
    if (wait > 8) await sleep(wait);
    else await nextFrame();
  }

  while (!sim.done && frames < maxBattleFrames) {
    stepSim(sim, dt);
    paintFrame(ctx, sim, {
      channelName: opts.channelName,
      phaseLabel: `${standCountLabel(sim)} · LAST FLAG STANDING`,
    });
    reportProgress(
      opts.onProgress,
      `${standing(sim).length} left`,
      0.08 + 0.75 * clamp01(sim.elapsed / MAX_BATTLE_SEC)
    );
    await waitForFrame();
  }

  // Winner hold + anthem (same FPS clock — no speed-up)
  if (sim.winner && audioCtx && dest) {
    try {
      let buf = await loadAnthemBuffer(sim.winner.code, audioCtx);
      if (!buf) buf = makeFanfareBuffer(audioCtx, 1);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const g = audioCtx.createGain();
      g.gain.value = 0.85;
      src.connect(g);
      g.connect(dest);
      const play = Math.min(HOLD_WIN_SEC, buf.duration || HOLD_WIN_SEC);
      src.start(0, 0, play);
    } catch {
      /* ignore audio */
    }
  }

  const holdFrames = Math.ceil(HOLD_WIN_SEC * FPS);
  for (let i = 0; i < holdFrames; i++) {
    paintFrame(ctx, sim, {
      channelName: opts.channelName,
      phaseLabel: sim.winner
        ? `${sim.winner.name} WINS`
        : "LAST FLAG STANDING",
    });
    reportProgress(opts.onProgress, "Winner", 0.85 + 0.15 * ((i + 1) / holdFrames));
    await waitForFrame();
  }

  recorder.stop();
  await doneRec;
  stream.getTracks().forEach((tr) => tr.stop());
  try {
    await audioCtx?.close?.();
  } catch {
    /* ignore */
  }

  const blob = new Blob(chunks, {
    type: mimeType.includes("webm") ? "video/webm" : mimeType,
  });
  if (!blob.size) throw new Error("Recording produced an empty file.");

  reportProgress(opts.onProgress, "Done", 1);
  return {
    blob,
    mimeType,
    durationSec: frames / FPS,
    mode: "battle",
    winner: sim.winner
      ? { code: sim.winner.code, name: sim.winner.name }
      : null,
  };
}

function standCountLabel(sim) {
  return `${standing(sim).length} LEFT`;
}
