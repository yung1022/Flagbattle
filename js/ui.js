import { FlagBattleGame, CONFIG } from "./game.js";
import { COUNTRIES } from "./countries.js";

const game = new FlagBattleGame();

const els = {
  boardLabel: document.getElementById("board-label"),
  boardMeta: document.getElementById("board-meta"),
  boardTrack: document.getElementById("board-track"),
  phaseText: document.getElementById("phase-text"),
  timer: document.getElementById("timer"),
  arena: document.getElementById("arena"),
  feed: document.getElementById("feed"),
  statCountries: document.getElementById("stat-countries"),
  statFighting: document.getElementById("stat-fighting"),
  statBoard: document.getElementById("stat-board"),
  btnStart: document.getElementById("btn-start"),
  btnReset: document.getElementById("btn-reset"),
  winnerBanner: document.getElementById("winner-banner"),
  winnerFlag: document.getElementById("winner-flag"),
  winnerName: document.getElementById("winner-name"),
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
  el.innerHTML = `<img alt="${f.name}" src="${f.img}" loading="lazy" /><span class="hp"><i></i></span>`;
  els.arena.appendChild(el);
  fighterEls.set(f.id, el);
  return el;
}

function syncArena() {
  const visibleIds = new Set();
  const sizeBase =
    game.phase === "final"
      ? Math.max(36, Math.min(64, 520 / Math.max(8, game.standing().length)))
      : Math.max(22, Math.min(40, 900 / Math.max(40, game.standing().length + 20)));

  for (const f of game.fighters) {
    const show =
      (game.phase === "qualifying" && f.alive && !f.qualified) ||
      ((game.phase === "final" || game.phase === "finished") && f.alive) ||
      (game.phase === "idle" && f.alive);

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
    const bar = el.querySelector(".hp > i");
    if (bar) bar.style.transform = `scaleX(${Math.max(0, f.hp / f.maxHp)})`;
  }

  // Drop stale nodes from previous phase resets.
  for (const [id, el] of fighterEls) {
    if (!visibleIds.has(id) && !el.classList.contains("eliminating")) {
      el.remove();
      fighterEls.delete(id);
    }
  }
}

function renderBoard() {
  const flags = game.boardFlags();
  const isQual =
    game.phase === "qualifying" || game.phase === "idle";
  els.boardLabel.textContent = isQual
    ? "QUALIFIED FOR FINAL"
    : game.phase === "finished"
      ? "CHAMPION"
      : "FLAGS STANDING";
  els.boardMeta.textContent = isQual
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
      game.phase === "qualifying"
        ? "Waiting for first qualifier…"
        : game.phase === "idle"
          ? "Press Start to begin qualifying"
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

  // Duplicate for seamless marquee when many flags.
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
  els.statFighting.textContent = String(fighting);
  els.statBoard.textContent = String(game.boardFlags().length);

  if (game.phase === "qualifying") {
    els.phaseText.textContent = "Qualifying";
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

  els.btnStart.disabled = game.phase === "qualifying" || game.phase === "final";
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

function render() {
  renderBoard();
  syncArena();
  renderFeed();
  renderHud();
}

els.btnStart.addEventListener("click", () => {
  fighterEls.forEach((el) => el.remove());
  fighterEls.clear();
  lastBoardKey = "";
  lastEventAt = 0;
  els.feed.innerHTML = "";
  game.start();
});

els.btnReset.addEventListener("click", () => {
  fighterEls.forEach((el) => el.remove());
  fighterEls.clear();
  lastBoardKey = "";
  lastEventAt = 0;
  els.feed.innerHTML = "";
  game.reset();
  render();
});

if (new URLSearchParams(location.search).has("stream")) {
  document.body.classList.add("stream-mode");
}

game.onChange = render;
game.reset();
render();

// Autostart for unattended livestream OBS scenes.
if (new URLSearchParams(location.search).has("autostart")) {
  game.start();
}
