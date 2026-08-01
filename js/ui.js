import { FlagBattleGame, CONFIG, flagSizeForCount } from "./game.js";
import { COUNTRIES } from "./countries.js";

const game = new FlagBattleGame();

const els = {
  boardLabel: document.getElementById("board-label"),
  boardMeta: document.getElementById("board-meta"),
  boardTrack: document.getElementById("board-track"),
  phaseText: document.getElementById("phase-text"),
  timer: document.getElementById("timer"),
  arena: document.getElementById("arena"),
  rimArc: document.getElementById("rim-arc"),
  holeArc: document.getElementById("hole-arc"),
  feed: document.getElementById("feed"),
  statCountries: document.getElementById("stat-countries"),
  statFighting: document.getElementById("stat-fighting"),
  statBoard: document.getElementById("stat-board"),
  btnStart: document.getElementById("btn-start"),
  btnReset: document.getElementById("btn-reset"),
  winnerBanner: document.getElementById("winner-banner"),
  winnerFlag: document.getElementById("winner-flag"),
  winnerName: document.getElementById("winner-name"),
  roundMeta: document.getElementById("round-meta"),
  intermission: document.getElementById("intermission"),
  intermissionTitle: document.getElementById("intermission-title"),
  intermissionSub: document.getElementById("intermission-sub"),
  intermissionTimer: document.getElementById("intermission-timer"),
};

const fighterEls = new Map();
let lastBoardKey = "";
let lastEventAt = 0;

function formatMs(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ensureFighterEl(f) {
  let el = fighterEls.get(f.id);
  if (el) return el;
  el = document.createElement("div");
  el.className = "fighter";
  el.dataset.id = f.id;
  el.innerHTML = `<img alt="${f.name}" src="${f.img}" loading="lazy" />`;
  els.arena.appendChild(el);
  fighterEls.set(f.id, el);
  return el;
}

function polar(cx, cy, r, angleRad) {
  return {
    x: cx + Math.cos(angleRad) * r,
    y: cy + Math.sin(angleRad) * r,
  };
}

function describeArc(cx, cy, r, startRad, endRad) {
  const start = polar(cx, cy, r, startRad);
  const end = polar(cx, cy, r, endRad);
  let delta = endRad - startRad;
  while (delta < 0) delta += Math.PI * 2;
  while (delta > Math.PI * 2) delta -= Math.PI * 2;
  const large = delta > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

function syncHole() {
  if (!els.rimArc || !els.holeArc) return;
  const { rotateDeg, widthDeg, radiusPct } = game.holeStyle();
  const r = radiusPct; // viewBox 0..100, center 50 → radius matches CONFIG
  const cx = 50;
  const cy = 50;
  const hole = (widthDeg * Math.PI) / 180;
  const mid = (rotateDeg * Math.PI) / 180;
  const holeStart = mid - hole / 2;
  const holeEnd = mid + hole / 2;
  // Solid rim = everything except the hole wedge.
  els.rimArc.setAttribute("d", describeArc(cx, cy, r, holeEnd, holeStart + Math.PI * 2));
  els.holeArc.setAttribute("d", describeArc(cx, cy, r, holeStart, holeEnd));
}

function syncArena() {
  syncHole();
  const visibleIds = new Set();
  const count = Math.max(
    1,
    game.standing().length + game.fighters.filter((f) => f.falling).length
  );
  const sizeBase = flagSizeForCount(count).px;

  for (const f of game.fighters) {
    const show =
      game.phase === "intermission"
        ? f.alive
        : f.alive || f.falling;
    if (!show) {
      const existing = fighterEls.get(f.id);
      if (existing && !existing.classList.contains("eliminating")) {
        existing.classList.add("eliminating");
        setTimeout(() => {
          existing.remove();
          fighterEls.delete(f.id);
        }, 520);
      }
      continue;
    }

    visibleIds.add(f.id);
    const el = ensureFighterEl(f);
    el.style.setProperty("--size", `${sizeBase}px`);
    el.style.left = `${f.x * 100}%`;
    el.style.top = `${f.y * 100}%`;
    el.classList.toggle("pulse", f.pulse > 0.2);
    el.classList.toggle("falling", f.falling);
  }

  for (const [id, el] of fighterEls) {
    if (!visibleIds.has(id) && !el.classList.contains("eliminating")) {
      el.remove();
      fighterEls.delete(id);
    }
  }
}

function renderBoard() {
  const flags = game.boardFlags();
  const showQualifiedBoard =
    game.phase === "qualifying" ||
    game.phase === "idle" ||
    game.phase === "between_rounds" ||
    game.phase === "intermission";
  els.boardLabel.textContent = showQualifiedBoard
    ? "QUALIFIED FOR FINAL"
    : game.phase === "finished"
      ? "CHAMPION"
      : "FLAGS STANDING";
  els.boardMeta.textContent = showQualifiedBoard
    ? `${flags.length} / ${CONFIG.finalistSlots}`
    : `${flags.length} standing`;

  const key = `${game.phase}:${flags.map((f) => f.code).join(",")}`;
  if (key === lastBoardKey) return;
  lastBoardKey = key;

  els.boardTrack.classList.toggle("marquee", flags.length > 10);
  els.boardTrack.innerHTML = "";

  if (!flags.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent =
      game.phase === "intermission" && game.intermissionKind === "open"
        ? "Qualifying starts after intermission…"
        : game.phase === "qualifying" || game.phase === "between_rounds"
          ? "Waiting for first qualifier…"
          : game.phase === "idle"
            ? "Press Start — last flag in the circle qualifies"
            : "—";
    els.boardTrack.appendChild(empty);
    return;
  }

  const row = document.createElement("div");
  row.className = "board-row";
  for (const f of flags) {
    const img = document.createElement("img");
    img.className = "board-flag";
    img.src = f.img;
    img.alt = f.name;
    img.title = f.name;
    row.appendChild(img);
  }
  els.boardTrack.appendChild(row);

  if (flags.length > 10) {
    const clone = row.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    els.boardTrack.appendChild(clone);
  }
}

function renderFeed() {
  const latest = game.events[0];
  if (!latest || latest.at === lastEventAt) return;
  lastEventAt = latest.at;
  const item = document.createElement("div");
  item.className = `feed-item ${latest.type}`;
  item.textContent = latest.text;
  els.feed.prepend(item);
  while (els.feed.children.length > 3) {
    els.feed.lastElementChild.remove();
  }
}

function renderHud() {
  const fighting = game.standing().length;
  els.statCountries.textContent = String(COUNTRIES.length);
  els.statFighting.textContent = String(
    game.phase === "intermission" ? game.fighters.filter((f) => f.alive).length : fighting
  );
  els.statBoard.textContent = String(game.boardFlags().length);

  if (els.roundMeta) {
    if (game.phase === "idle") els.roundMeta.textContent = "Hole circle · no damage";
    else if (game.phase === "intermission")
      els.roundMeta.textContent =
        game.intermissionKind === "final"
          ? "Intermission · Final next"
          : "Intermission · Qualifying next";
    else if (game.phase === "final" || game.phase === "finished")
      els.roundMeta.textContent = `Final · Round ${game.round}`;
    else els.roundMeta.textContent = `Qualifying · Round ${game.round}`;
  }

  if (game.phase === "intermission") {
    els.phaseText.textContent = "Intermission";
    els.timer.textContent = formatMs(game.intermissionRemainingMs());
    els.timer.hidden = false;
  } else if (game.phase === "qualifying" || game.phase === "between_rounds") {
    els.phaseText.textContent =
      game.phase === "between_rounds" ? "Qualifier locked" : "Qualifying";
    els.timer.textContent = formatMs(game.qualifyingRemainingMs());
    els.timer.hidden = false;
  } else if (game.phase === "final") {
    els.phaseText.textContent = "Last Flag Standing";
    els.timer.textContent = `${fighting} LEFT`;
    els.timer.hidden = false;
  } else if (game.phase === "finished") {
    els.phaseText.textContent = "Champion";
    els.timer.hidden = true;
  } else {
    els.phaseText.textContent = "Ready";
    els.timer.textContent = formatMs(CONFIG.qualifyingMs);
    els.timer.hidden = false;
  }

  if (els.intermission) {
    const show = game.phase === "intermission";
    els.intermission.classList.toggle("show", show);
    if (show) {
      const opening = game.intermissionKind === "open";
      els.intermissionTitle.textContent = opening
        ? "GET READY"
        : "FINAL INCOMING";
      els.intermissionSub.textContent = opening
        ? `${COUNTRIES.length} countries · hole circle qualifying`
        : `${game.qualified.length} qualified · Last Flag Standing`;
      els.intermissionTimer.textContent = formatMs(game.intermissionRemainingMs());
    }
  }

  const busy =
    game.phase === "qualifying" ||
    game.phase === "between_rounds" ||
    game.phase === "intermission" ||
    game.phase === "final";
  els.btnStart.disabled = busy;
  els.btnStart.textContent =
    game.phase === "finished" || game.phase === "idle" ? "Start Battle" : "In Progress";

  if (game.phase === "finished" && game.winner) {
    els.winnerBanner.classList.add("show");
    els.winnerFlag.src = game.winner.img;
    els.winnerFlag.alt = game.winner.name;
    els.winnerName.textContent = game.winner.name;
  } else {
    els.winnerBanner.classList.remove("show");
  }
}

function clearFighters() {
  fighterEls.forEach((el) => el.remove());
  fighterEls.clear();
  lastBoardKey = "";
  lastEventAt = 0;
  els.feed.innerHTML = "";
}

function render() {
  renderBoard();
  syncArena();
  renderFeed();
  renderHud();
}

els.btnStart.addEventListener("click", () => {
  clearFighters();
  game.start();
});

els.btnReset.addEventListener("click", () => {
  clearFighters();
  game.reset();
  render();
});

const params = new URLSearchParams(location.search);
const mobileMode = params.has("mobile") || params.has("stream");

if (params.has("stream")) {
  document.body.classList.add("stream-mode");
}
if (params.has("mobile")) {
  document.body.classList.add("mobile-mode");
}

game.onChange = render;
game.reset();
// Idle preview: scatter flags in the circle without running physics.
game.fighters = COUNTRIES.map((c, i) => {
  const angle = (i / COUNTRIES.length) * Math.PI * 2;
  const radius = 0.12 + (i % 5) * 0.05;
  return {
    ...c,
    id: c.code,
    alive: true,
    falling: false,
    qualified: false,
    x: 0.5 + Math.cos(angle) * radius,
    y: 0.5 + Math.sin(angle) * radius,
    vx: 0,
    vy: 0,
    img: `https://flagcdn.com/w80/${c.code}.png`,
    pulse: 0,
  };
});
render();

if (params.has("autostart")) {
  clearFighters();
  game.start();
}

/** Keep screen awake + offer fullscreen for phone screen-share streams. */
async function enableMobileStreamHelpers() {
  if (!mobileMode) return;

  const stage = document.getElementById("stage");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-fs-btn";
  btn.textContent = "Fullscreen";
  btn.addEventListener("click", async () => {
    try {
      const el = stage || document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
      // iOS Safari video fullscreen fallback: scroll stage into view.
      stage?.scrollIntoView({ block: "center" });
    } catch {
      /* ignore */
    }
    await requestWakeLock();
  });
  document.body.appendChild(btn);

  await requestWakeLock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    /* unsupported / denied */
  }
}

enableMobileStreamHelpers();
