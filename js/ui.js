import { FlagBattleGame, CONFIG, flagSizeForCount, IS_TEST_STREAM, TEST_STREAM } from "./game.js";
import { COUNTRIES } from "./countries.js";
import { fetchPoll, fetchStreamsFromApi, listStreams } from "./store.js";
import { buildPointsLeaderboard } from "./rankings-stats.js";
import { siteBase as resolveSiteBase } from "./public.js";
import {
  announceRoundWinner,
  unlockAudio,
  ensureStreamAudio,
  startAmbientMusic,
} from "./sfx.js";

const game = new FlagBattleGame();
const params = new URLSearchParams(location.search);

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
  rankReveal: document.getElementById("rank-reveal"),
  rankRevealKicker: document.querySelector("#rank-reveal .rank-reveal-kicker"),
  rankRevealFlag: document.getElementById("rank-reveal-flag"),
  rankRevealName: document.getElementById("rank-reveal-name"),
  rankRevealWin: document.querySelector("#rank-reveal .rank-reveal-win"),
  rankRevealChange: document.getElementById("rank-reveal-change"),
  rankRevealFrom: document.getElementById("rank-reveal-from"),
  rankRevealTo: document.getElementById("rank-reveal-to"),
  rankRevealMeta: document.getElementById("rank-reveal-meta"),
  roundMeta: document.getElementById("round-meta"),
  streamLink: document.getElementById("stream-link"),
  streamLinks: document.getElementById("stream-links"),
  streamPoll: document.getElementById("stream-poll"),
  streamPollRows: document.getElementById("stream-poll-rows"),
  streamPollTotal: document.getElementById("stream-poll-total"),
  streamRecentVotes: document.getElementById("stream-recent-votes"),
  streamRecentVotesHead: document.getElementById("stream-recent-votes-head"),
  streamRecentVotesRows: document.getElementById("stream-recent-votes-rows"),
  streamRecentVotesHint: document.getElementById("stream-recent-votes-hint"),
  streamShoutout: document.getElementById("stream-shoutout"),
  streamShoutoutHead: document.getElementById("stream-shoutout-head"),
  streamShoutoutTimer: document.getElementById("stream-shoutout-timer"),
  streamShoutoutCard: document.getElementById("stream-shoutout-card"),
  streamShoutoutHint: document.getElementById("stream-shoutout-hint"),
  finalistsReveal: document.getElementById("finalists-reveal"),
  finalistsTitle: document.getElementById("finalists-title"),
  finalistsLive: document.getElementById("finalists-live"),
  finalistsScroll: document.getElementById("finalists-scroll"),
  finalistsCount: document.getElementById("finalists-count"),
};

/** Public site root for QR/links shown on the livestream (viewers can't click video). */
function siteBase() {
  return resolveSiteBase(location.search);
}

function pageUrl(file, query = "") {
  const base = siteBase();
  const qs = new URLSearchParams(
    typeof query === "string" && query ? query : ""
  );
  // Embed live API so GitHub Pages poll/rankings can reach the stream server.
  const api =
    params.get("api") ||
    localStorage.getItem("flagbattle.apiBase") ||
    "";
  if (api && !qs.has("api")) qs.set("api", api.replace(/\/$/, ""));
  const q = qs.toString();
  return `${base}/${file}${q ? `?${q}` : ""}`;
}

let lastLinkKey = "";
let lastPollKey = "";
let pollTimer = 0;
let lastAnnouncedAt = 0;

const fighterEls = new Map();
let lastBoardKey = "";
let lastEventAt = 0;
let lastSize = 0;

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
  el.innerHTML = `
    <div class="spawn-label" hidden></div>
    <img alt="${f.name}" src="${f.img}" loading="lazy" decoding="async" />
    <div class="hp-bar" hidden><i></i></div>
  `;
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
  const r = radiusPct;
  const cx = 50;
  const cy = 50;
  const hole = (widthDeg * Math.PI) / 180;
  const mid = (rotateDeg * Math.PI) / 180;
  const holeStart = mid - hole / 2;
  const holeEnd = mid + hole / 2;
  // Keep guide track + floor rim in sync with physics radius.
  const track = document.querySelector(".rim-track");
  if (track) track.setAttribute("r", String(r));
  const wrap = els.arena?.parentElement;
  if (wrap) wrap.style.setProperty("--rim", `${r}%`);
  els.rimArc.setAttribute("d", describeArc(cx, cy, r, holeEnd, holeStart + Math.PI * 2));
  els.holeArc.setAttribute("d", describeArc(cx, cy, r, holeStart, holeEnd));
}

let arenaSide = 0;
let lastHoleKey = "";

/** Keep the playfield a true square (physics unit circle ↔ pixels). */
function layoutSquareArena(force = false) {
  const wrap = els.arena?.parentElement;
  if (!wrap || !els.arena) return arenaSide;
  const side = Math.min(wrap.clientWidth, wrap.clientHeight);
  if (side <= 0) return arenaSide;
  if (!force && side === arenaSide) return arenaSide;
  arenaSide = side;
  els.arena.style.width = `${side}px`;
  els.arena.style.height = `${side}px`;
  return arenaSide;
}

/** Hot path — positions only. Avoid layout/SVG work every frame. */
function syncArena() {
  const w = layoutSquareArena(false) || els.arena.clientWidth || 1;
  const h = w;

  const hole = game.holeStyle();
  const holeKey = `${hole.rotateDeg.toFixed(1)}:${hole.widthDeg.toFixed(1)}:${hole.radiusPct}`;
  if (holeKey !== lastHoleKey) {
    lastHoleKey = holeKey;
    syncHole();
  }

  let living = 0;
  let falling = 0;
  for (const f of game.fighters) {
    if (f.falling) falling += 1;
    else if (f.alive) living += 1;
  }
  const count = Math.max(1, living + falling);
  const sizeBase = flagSizeForCount(count).px;
  const sizeChanged = sizeBase !== lastSize;
  if (sizeChanged) lastSize = sizeBase;

  const showAllAlive = game.phase === "qualifying_hold";
  const visibleIds = new Set();
  const hunterCode = game.arenaEvent?.hunterCode || "";

  for (const f of game.fighters) {
    const show = showAllAlive ? f.alive : f.alive || f.falling;
    if (!show) {
      const existing = fighterEls.get(f.id);
      if (existing && !existing.classList.contains("eliminating")) {
        existing.classList.add("eliminating");
        setTimeout(() => {
          existing.remove();
          fighterEls.delete(f.id);
        }, 400);
      }
      continue;
    }

    visibleIds.add(f.id);
    const el = ensureFighterEl(f);
    const sizeMult = Number(f.sizeMult) || 1;
    const px = Math.round(sizeBase * Math.max(0.85, Math.min(2.8, sizeMult)));
    el.style.setProperty("--size", `${px}px`);
    const x = f.x * w;
    const y = f.y * h;
    const pulse = f.pulse > 0.2 ? 1.12 : 1;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${pulse})`;
    if (el.classList.contains("falling") !== f.falling) {
      el.classList.toggle("falling", f.falling);
    }
    el.classList.toggle("big-flag", sizeMult >= 1.4);
    el.classList.toggle("catcher", Boolean(hunterCode && f.code === hunterCode));

    const battling =
      (game.phase === "main" ||
        game.phase === "invasion" ||
        game.finalStage === "swiss" ||
        game.finalStage === "battle" ||
        game.finalStage === "main" ||
        game.finalStage === "invasion") &&
      f.alive &&
      !f.falling;
    el.classList.toggle("battling", battling);

    const bar = el.querySelector(".hp-bar");
    if (bar) {
      bar.hidden = !battling;
      if (battling) {
        bar.removeAttribute("hidden");
        const maxHp = f.maxHp || CONFIG.baseHp || 100;
        const pct = Math.max(0, Math.min(100, ((f.hp ?? maxHp) / maxHp) * 100));
        const fill = bar.querySelector("i");
        if (fill) {
          fill.style.width = `${pct}%`;
          bar.classList.toggle("low", pct <= 30);
          bar.classList.toggle("mid", pct > 30 && pct <= 60);
        }
      }
    }

    const label = el.querySelector(".spawn-label");
    if (label) {
      const who = String(f.spawnedBy || "").trim();
      if (who) {
        const text = who.length > 16 ? `${who.slice(0, 15)}…` : who;
        if (label.dataset.who !== who) {
          label.dataset.who = who;
          label.textContent = text;
          label.title = who;
        }
        label.hidden = false;
        el.classList.add("has-spawner");
      } else {
        if (label.dataset.who) {
          label.dataset.who = "";
          label.textContent = "";
          label.removeAttribute("title");
        }
        label.hidden = true;
        el.classList.remove("has-spawner");
      }
    }
  }

  syncArenaHazards(w);

  if (fighterEls.size !== visibleIds.size) {
    for (const [id, el] of fighterEls) {
      if (!visibleIds.has(id) && !el.classList.contains("eliminating")) {
        el.remove();
        fighterEls.delete(id);
      }
    }
  }
}

function isSprintPhase() {
  return (
    game.phase === "sprint" ||
    (game.phase === "between_rounds" &&
      (game._pendingSprintReset || game._pendingSprintEnd))
  );
}

function isSpawnVotePhase() {
  return (
    isSprintPhase() ||
    isMainPhase() ||
    game.phase === "main" ||
    game.phase === "invasion"
  );
}

/** Event FX + alien ships overlaid on the arena. */
function syncArenaHazards(arenaPx) {
  let layer = document.getElementById("arena-hazards");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "arena-hazards";
    layer.className = "arena-hazards";
    layer.setAttribute("aria-hidden", "true");
    els.arena.appendChild(layer);
  }

  const ev = game.arenaEvent;
  const aliens = Array.isArray(game.aliens) ? game.aliens : [];
  const parts = [];

  if (ev?.type === "saw") {
    const deg = (((ev.spin || 0) * 180) / Math.PI).toFixed(1);
    const x = (ev.x ?? 0.5) * arenaPx;
    const y = (ev.y ?? 0.5) * arenaPx;
    parts.push(
      `<div class="hazard-saw" style="transform:translate3d(${x}px,${y}px,0) translate(-50%,-50%) rotate(${deg}deg)"></div>`
    );
  }
  if (ev?.type === "blackhole") {
    parts.push(`<div class="hazard-blackhole"></div>`);
  }
  if (ev?.type === "catch") {
    parts.push(
      `<div class="hazard-catch-banner">${ev.label || "CATCH"}</div>`
    );
  }
  if (game.phase === "invasion" || aliens.length) {
    for (let i = 0; i < aliens.length; i++) {
      const a = aliens[i];
      const x = (a.x || 0.5) * arenaPx;
      const y = (a.y || 0.5) * arenaPx;
      parts.push(
        `<div class="hazard-alien" style="transform:translate3d(${x}px,${y}px,0) translate(-50%,-50%)"><i></i></div>`
      );
    }
  }
  const html = parts.join("");
  if (layer.dataset.html !== html) {
    layer.dataset.html = html;
    layer.innerHTML = html;
  }
  layer.hidden = !parts.length;
}

/** Qualifying / Final left board alternates with championship Top 10 (not Sprint). */
const BOARD_VIEW_LIVE = "live";
const BOARD_VIEW_POINTS = "points";
const BOARD_MAX_SHOW_MS = 30_000;
const BOARD_STATIC_SHOW_MS = 12_000;

let boardView = BOARD_VIEW_LIVE;
let boardRotateTimer = 0;
let boardRotateGen = 0;
let championshipTop10 = [];
let championshipTop10Key = "";
let championshipRefreshTimer = 0;

function isMainPhase() {
  return (
    game.phase === "main" ||
    (game.phase === "between_rounds" && game._pendingMainReset)
  );
}

function shouldRotateBoardViews() {
  if (isSprintPhase()) return false;
  if (game.phase === "idle") return false;
  // Main / Invasion / legacy Qual+Final — alternate with championship Top 10.
  return (
    game.phase === "main" ||
    game.phase === "invasion" ||
    game.phase === "qualifying" ||
    game.phase === "qualifying_hold" ||
    game.phase === "qualifying_complete" ||
    game.phase === "between_rounds" ||
    game.phase === "final" ||
    game.phase === "finished"
  );
}

async function refreshChampionshipTop10() {
  try {
    const fromApi = await fetchStreamsFromApi();
    const streams =
      Array.isArray(fromApi) && fromApi.length ? fromApi : listStreams();
    const board = buildPointsLeaderboard(streams || [], COUNTRIES);
    championshipTop10 = board.slice(0, 10).map((r) => ({
      code: r.code,
      name: r.name,
      img: r.img || `https://flagcdn.com/w80/${r.code}.png`,
      points: Number(r.points) || 0,
      rank: Number(r.rank) || 0,
    }));
    championshipTop10Key = championshipTop10
      .map((r) => `${r.code}:${r.points}`)
      .join(",");
  } catch (err) {
    console.warn("[board] championship top 10", err?.message || err);
  }
}

function ensureChampionshipTop10Refresh() {
  if (championshipRefreshTimer) return;
  refreshChampionshipTop10();
  championshipRefreshTimer = setInterval(refreshChampionshipTop10, 60_000);
}

function clearBoardRotateTimer() {
  if (boardRotateTimer) {
    clearTimeout(boardRotateTimer);
    boardRotateTimer = 0;
  }
}

function scheduleBoardViewRotation(showMs) {
  clearBoardRotateTimer();
  if (!shouldRotateBoardViews()) {
    if (boardView !== BOARD_VIEW_LIVE) {
      boardView = BOARD_VIEW_LIVE;
      lastBoardKey = "";
    }
    return;
  }
  // Need a points list before flipping away from live content.
  if (!championshipTop10.length) {
    ensureChampionshipTop10Refresh();
    const gen = ++boardRotateGen;
    boardRotateTimer = setTimeout(() => {
      if (gen !== boardRotateGen) return;
      if (!shouldRotateBoardViews()) return;
      if (championshipTop10.length) {
        boardView = BOARD_VIEW_POINTS;
        lastBoardKey = "";
        renderBoard();
      } else {
        scheduleBoardViewRotation(BOARD_STATIC_SHOW_MS);
      }
    }, 5000);
    return;
  }
  const gen = ++boardRotateGen;
  const wait = Math.max(2500, Math.min(BOARD_MAX_SHOW_MS, showMs));
  boardRotateTimer = setTimeout(() => {
    if (gen !== boardRotateGen) return;
    if (!shouldRotateBoardViews()) {
      boardView = BOARD_VIEW_LIVE;
      lastBoardKey = "";
      renderBoard();
      return;
    }
    boardView =
      boardView === BOARD_VIEW_LIVE ? BOARD_VIEW_POINTS : BOARD_VIEW_LIVE;
    lastBoardKey = "";
    renderBoard();
  }, wait);
}

function renderBoard() {
  const sprintBoard = isSprintPhase();
  const mainBoard = isMainPhase();
  const rotate = shouldRotateBoardViews();
  if (sprintBoard || !rotate) {
    boardView = BOARD_VIEW_LIVE;
    clearBoardRotateTimer();
  } else {
    ensureChampionshipTop10Refresh();
  }

  if (boardView === BOARD_VIEW_POINTS && !championshipTop10.length) {
    boardView = BOARD_VIEW_LIVE;
  }
  const showingPoints =
    rotate && boardView === BOARD_VIEW_POINTS && championshipTop10.length > 0;
  const flags = showingPoints ? championshipTop10 : game.boardFlags();
  const qualBoard =
    !sprintBoard &&
    !mainBoard &&
    !showingPoints &&
    game.streamMode !== "final" &&
    (game.phase === "qualifying" ||
      game.phase === "qualifying_hold" ||
      game.phase === "qualifying_complete" ||
      game.phase === "idle" ||
      game.phase === "between_rounds" ||
      (game.phase === "finished" && !game.winner));

  if (showingPoints) {
    els.boardLabel.textContent = "CHAMPIONSHIP";
    els.boardMeta.textContent = "Top 10 · season points (50→1)";
  } else if (sprintBoard) {
    els.boardLabel.textContent = "OPENING WINS";
    els.boardMeta.textContent = flags.length
      ? `${flags.length} win${flags.length === 1 ? "" : "s"} · unscored`
      : "Type a country to spawn (= vote)";
  } else if (mainBoard) {
    els.boardLabel.textContent = "MAIN POINTS";
    els.boardMeta.textContent = flags.length
      ? `${flags.length} scoring · last standing = +1`
      : "Last standing earns a point · most points wins";
  } else if (game.phase === "invasion") {
    els.boardLabel.textContent = "INVASION";
    els.boardMeta.textContent = flags.length
      ? `${flags.length} fallen · most Main points wins`
      : "Pressure round · most Main points wins";
  } else if (game.streamMode === "final") {
    if (game.phase === "finished" && game.winner) {
      els.boardLabel.textContent = "CHAMPION";
      els.boardMeta.textContent = game.winner.name;
    } else if (game._swissBoardActive?.() || game.finalStage === "swiss") {
      els.boardLabel.textContent = "FINAL 4 CUT";
      const plays = (game._swissPool || []).map((p) => Number(p.played) || 0);
      const minPlayed = plays.length ? Math.min(...plays) : 0;
      els.boardMeta.textContent = `Top 4 by score · ${minPlayed}/${CONFIG.swissRounds} matches`;
    } else if (game.finalStage === "battle") {
      els.boardLabel.textContent = "LAST FLAG STANDING";
      els.boardMeta.textContent = `${flags.length} left`;
    } else {
      els.boardLabel.textContent = "FINAL";
      els.boardMeta.textContent = `${flags.length} standing`;
    }
  } else {
    els.boardLabel.textContent = qualBoard
      ? "QUALIFIED FOR FINAL"
      : game.phase === "finished"
        ? "CHAMPION"
        : "FLAGS STANDING";
    els.boardMeta.textContent = qualBoard
      ? `${flags.length} qualified`
      : `${flags.length} standing`;
  }

  const key = showingPoints
    ? `points:${championshipTop10Key}`
    : `live:${game.phase}:${game.finalStage}:${game.swissRound}:${flags
        .map((f) => `${f.code}:${f.points ?? ""}`)
        .join(",")}`;
  if (key === lastBoardKey) {
    if (rotate && !boardRotateTimer) {
      scheduleBoardViewRotation(BOARD_STATIC_SHOW_MS);
    }
    return;
  }
  lastBoardKey = key;

  const streamMode = document.body.classList.contains("stream-mode");
  const needScroll = streamMode ? flags.length > 4 : flags.length > 8;
  els.boardTrack.classList.toggle("marquee", needScroll);
  // One pass to the bottom while rotating; infinite loop on Sprint / idle.
  els.boardTrack.classList.toggle("marquee-once", needScroll && rotate);
  els.boardTrack.innerHTML = "";

  if (!flags.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = sprintBoard
      ? "No opening wins yet — last flag standing wins the round"
      : mainBoard
        ? "No Main points yet — last standing earns +1"
        : game.phase === "qualifying" ||
            game.phase === "between_rounds" ||
            game.phase === "qualifying_hold"
          ? "Waiting for first qualifier…"
          : game.phase === "idle"
            ? "Press Start — Opening → Main → Invasion"
            : "—";
    els.boardTrack.appendChild(empty);
    if (rotate) scheduleBoardViewRotation(BOARD_STATIC_SHOW_MS);
    return;
  }

  const row = document.createElement("div");
  row.className = "board-row";
  for (const f of flags) {
    const chip = document.createElement("div");
    chip.className = "board-chip";
    const img = document.createElement("img");
    img.className = "board-flag";
    img.src = f.img;
    img.alt = f.name;
    img.title = f.name;
    const name = document.createElement("span");
    name.className = "board-chip-name";
    const pts = Number(f.points);
    if (showingPoints) {
      const rank = Number(f.rank) || "";
      name.textContent = `${rank ? `${rank}. ` : ""}${f.name} · ${pts}`;
    } else if (mainBoard && Number.isFinite(pts) && pts > 0) {
      name.textContent = `${f.name} · ${pts}`;
    } else if (
      Number.isFinite(pts) &&
      (game._swissBoardActive?.() || game.finalStage === "swiss")
    ) {
      name.textContent = `${f.name} · ${pts}`;
    } else {
      name.textContent = f.name;
    }
    chip.appendChild(img);
    chip.appendChild(name);
    row.appendChild(chip);
  }
  els.boardTrack.appendChild(row);
  let scrollSec = BOARD_STATIC_SHOW_MS / 1000;
  if (needScroll) {
    const clone = row.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    els.boardTrack.appendChild(clone);
    // Pace scroll by list length so long boards stay readable.
    scrollSec = Math.min(48, Math.max(14, flags.length * 1.6));
    els.boardTrack.style.setProperty("--board-scroll-s", `${scrollSec}s`);
  } else {
    els.boardTrack.style.removeProperty("--board-scroll-s");
  }

  if (rotate) {
    // Switch after one scroll to the bottom, capped at 30s.
    scheduleBoardViewRotation(
      needScroll ? scrollSec * 1000 : BOARD_STATIC_SHOW_MS
    );
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
  maybeAnnounce(latest);
}

function maybeAnnounce(event) {
  if (!event || event.at === lastAnnouncedAt) return;
  lastAnnouncedAt = event.at;
  // Keep ambient alive on feed activity (helps after tab focus / autoplay).
  startAmbientMusic({ force: false });
  if (event.type === "qualify") {
    const name =
      game.qualified?.[game.qualified.length - 1]?.name ||
      String(event.text || "").split(" ")[0] ||
      "A country";
    announceRoundWinner(name, { champion: false });
  } else if (event.type === "winner") {
    announceRoundWinner(game.winner?.name || "Champion", { champion: true });
  } else if (event.type === "rank_reveal") {
    // Refresh Top 10 so the board catches the new win after the reveal.
    refreshChampionshipTop10();
  }
}

function renderHud() {
  const fighting = game.standing().length;
  const inFinal =
    game.streamMode === "final" ||
    game.phase === "final" ||
    (game.phase === "between_rounds" && game.finalStage);

  els.statCountries.textContent = String(COUNTRIES.length);
  els.statFighting.textContent = String(fighting);
  els.statBoard.textContent = String(game.boardFlags().length);

  document.body.classList.toggle("final-mode", game.streamMode === "final");
  document.body.classList.toggle(
    "qual-complete",
    game.phase === "qualifying_complete"
  );
  document.body.classList.toggle("test-stream", IS_TEST_STREAM);
  let badge = document.getElementById("test-stream-badge");
  if (IS_TEST_STREAM) {
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "test-stream-badge";
      badge.className = "test-stream-badge";
      document.querySelector(".stage")?.appendChild(badge);
    }
    badge.textContent =
      TEST_STREAM === "full"
        ? "TEST · FULL BATTLE · no save"
        : `TEST · ${TEST_STREAM} · no save`;
    badge.hidden = false;
  } else if (badge) {
    badge.hidden = true;
  }

  if (els.roundMeta) {
    if (game.phase === "idle")
      els.roundMeta.textContent = "Opening → Main → Alien Invasion";
    else if (isSprintPhase())
      els.roundMeta.textContent =
        "Opening · spawn = vote · big flag every 5 votes · wins unscored";
    else if (isMainPhase() || game.phase === "main") {
      const revealingMainPoint =
        game.rankReveal?.kind === "main_point" &&
        game._winRevealUntil &&
        performance.now() < game._winRevealUntil;
      if (revealingMainPoint) {
        const rr = game.rankReveal;
        const rankLine =
          rr.fromRank != null
            ? `#${rr.fromRank} → #${rr.toRank}`
            : `→ #${rr.toRank ?? 1}`;
        els.roundMeta.textContent = `+1 Main point · ${rankLine} · full rank reveal`;
      } else {
        const ev = game.arenaEvent;
        const nextMs =
          typeof game.nextEventRemainingMs === "function"
            ? game.nextEventRemainingMs()
            : 0;
        const evMs =
          typeof game.eventRemainingMs === "function"
            ? game.eventRemainingMs()
            : 0;
        els.roundMeta.textContent = ev
          ? `EVENT · ${ev.label || ev.type} · ${formatMs(evMs)} left`
          : `Last standing = +1 point · next event ${formatMs(nextMs)} · most points wins`;
      }
    } else if (game.phase === "invasion")
      els.roundMeta.textContent =
        "Alien invasion · hole sealed · most Main points wins";
    else if (game.phase === "qualifying_hold")
      els.roundMeta.textContent = "All qualified · waiting on clock";
    else if (game.phase === "qualifying_complete")
      els.roundMeta.textContent = "Finalists locked · see overlay";
    else if (inFinal && game.finalStage === "swiss")
      els.roundMeta.textContent = `Swiss 1v1 · every country plays ${CONFIG.swissRounds} · +1 win`;
    else if (inFinal && game.finalStage === "battle")
      els.roundMeta.textContent = `Final 4 · 100 HP · −${CONFIG.hitDamage}/hit`;
    else if (inFinal && (game.phase === "final" || game.phase === "finished"))
      els.roundMeta.textContent =
        game.finalStage === "hole" || !game.finalStage
          ? `Final hole · reset on fall · Round ${game.round}`
          : `Final · Round ${game.round}`;
    else if (game.phase === "between_rounds" && !inFinal)
      els.roundMeta.textContent = `Qualifying · Round ${game.round}`;
    else els.roundMeta.textContent = `Qualifying · Round ${game.round}`;
  }

  if (isSprintPhase()) {
    els.phaseText.textContent = "Opening";
    els.timer.textContent = formatMs(game.sprintRemainingMs());
    els.timer.hidden = false;
  } else if (isMainPhase() || game.phase === "main") {
    els.phaseText.textContent = game.arenaEvent
      ? `Event · ${game.arenaEvent.type}`
      : "Main";
    els.timer.textContent = formatMs(
      typeof game.mainRemainingMs === "function"
        ? game.mainRemainingMs()
        : 0
    );
    els.timer.hidden = false;
  } else if (game.phase === "invasion") {
    els.phaseText.textContent = "Invasion";
    const invMs =
      typeof game.invasionRemainingMs === "function"
        ? game.invasionRemainingMs()
        : 0;
    els.timer.textContent = invMs > 0 ? formatMs(invMs) : `${fighting} LEFT`;
    els.timer.hidden = false;
  } else if (game.phase === "qualifying_complete") {
    els.phaseText.textContent = "Finalists";
    els.timer.hidden = true;
  } else if (inFinal && (game.phase === "final" || game.phase === "between_rounds")) {
    if (game.finalStage === "swiss") {
      els.phaseText.textContent = "Swiss 1v1";
      els.timer.textContent = `${fighting} LEFT`;
    } else if (game.finalStage === "battle") {
      els.phaseText.textContent = "Last Flag Standing";
      els.timer.textContent = `${fighting} LEFT`;
    } else {
      els.phaseText.textContent = "Last Flag Standing";
      els.timer.textContent = `${fighting} LEFT`;
    }
    els.timer.hidden = false;
  } else if (
    game.phase === "qualifying" ||
    game.phase === "between_rounds" ||
    game.phase === "qualifying_hold"
  ) {
    els.phaseText.textContent =
      game.phase === "between_rounds"
        ? "Qualifier locked"
        : game.phase === "qualifying_hold"
          ? "All qualified"
          : "Qualifying";
    els.timer.textContent = formatMs(game.qualifyingRemainingMs());
    els.timer.hidden = false;
  } else if (game.phase === "finished") {
    if (game.streamMode === "qualifying" && !game.winner) {
      els.phaseText.textContent = "Qualifying complete";
      els.timer.hidden = true;
    } else {
      const holdMs =
        typeof game.winnerHoldRemainingMs === "function"
          ? game.winnerHoldRemainingMs()
          : 0;
      els.phaseText.textContent = holdMs > 0 ? "Champion" : "Champion";
      if (holdMs > 0) {
        els.timer.textContent = formatMs(holdMs);
        els.timer.hidden = false;
        els.roundMeta.textContent = "Winner hold · stream ends after countdown";
      } else {
        els.timer.hidden = true;
      }
    }
  } else {
    els.phaseText.textContent = "Ready";
    els.timer.textContent = formatMs(CONFIG.qualifyingMs);
    els.timer.hidden = false;
  }

  renderFinalistsReveal();

  if (els.streamLink && game.stream?.id) {
    els.streamLink.hidden = false;
    els.streamLink.href = `rankings.html?id=${encodeURIComponent(game.stream.id)}`;
    els.streamLink.textContent = "Rankings";
  }

  renderStreamLinks();

  const busy =
    game.phase === "sprint" ||
    game.phase === "main" ||
    game.phase === "invasion" ||
    game.phase === "qualifying" ||
    game.phase === "qualifying_hold" ||
    game.phase === "qualifying_complete" ||
    game.phase === "between_rounds" ||
    game.phase === "final";
  els.btnStart.disabled = busy;
  els.btnStart.textContent =
    game.phase === "finished" ||
    game.phase === "idle" ||
    game.phase === "qualifying_complete"
      ? "Start Battle"
      : "In Progress";

  renderRankReveal();

  const showingReveal = Boolean(game.rankReveal && game._winRevealUntil);
  if (game.phase === "finished" && game.winner && !showingReveal) {
    els.winnerBanner.classList.add("show");
    els.winnerFlag.src = game.winner.img;
    els.winnerFlag.alt = game.winner.name;
    els.winnerName.textContent = game.winner.name;
  } else {
    els.winnerBanner.classList.remove("show");
  }
}

function renderRankReveal() {
  const el = els.rankReveal;
  if (!el) return;
  const rr = game.rankReveal;
  const live =
    Boolean(rr && game._winRevealUntil) &&
    performance.now() < game._winRevealUntil;
  // Full-screen reveal only for Main last-standing points (not total-points crown).
  const show = live && rr?.kind === "main_point";
  el.hidden = !show;
  el.classList.toggle("show", show);
  if (!show || !rr) return;

  const isMainPoint = rr.kind === "main_point";
  if (els.rankRevealKicker) {
    els.rankRevealKicker.textContent = isMainPoint
      ? "MAIN POINTS"
      : "CHAMPIONSHIP";
  }
  if (els.rankRevealWin) {
    els.rankRevealWin.textContent = isMainPoint ? "+1 POINT" : "+1 WIN";
  }
  if (els.rankRevealFlag) {
    els.rankRevealFlag.src = rr.img || game.winner?.img || "";
    els.rankRevealFlag.alt = rr.name || "";
  }
  if (els.rankRevealName) els.rankRevealName.textContent = rr.name || "—";
  if (els.rankRevealFrom) {
    els.rankRevealFrom.textContent =
      rr.fromRank != null ? `#${rr.fromRank}` : "NEW";
  }
  if (els.rankRevealTo) {
    els.rankRevealTo.textContent = `#${rr.toRank ?? 1}`;
  }
  if (els.rankRevealChange) {
    els.rankRevealChange.classList.remove("up", "down", "flat");
    if (rr.delta == null || rr.delta === 0) {
      els.rankRevealChange.classList.add("flat");
    } else if (rr.delta > 0) {
      els.rankRevealChange.classList.add("up");
    } else {
      els.rankRevealChange.classList.add("down");
    }
  }
  if (els.rankRevealMeta) {
    const pts = Number(rr.points) || 0;
    if (isMainPoint) {
      if (rr.firstWin) {
        els.rankRevealMeta.textContent = `First Main point · ${pts} pt${
          pts === 1 ? "" : "s"
        }`;
      } else if (rr.delta != null && rr.delta !== 0) {
        const dir = rr.delta > 0 ? "up" : "down";
        els.rankRevealMeta.textContent = `${Math.abs(rr.delta)} ${dir} · ${pts} pt${
          pts === 1 ? "" : "s"
        }`;
      } else {
        els.rankRevealMeta.textContent = `${pts} pt${
          pts === 1 ? "" : "s"
        } · same place`;
      }
    } else if (rr.firstWin) {
      els.rankRevealMeta.textContent = `First win · ${pts} win${
        pts === 1 ? "" : "s"
      }`;
    } else if (rr.delta != null && rr.delta !== 0) {
      const dir = rr.delta > 0 ? "up" : "down";
      els.rankRevealMeta.textContent = `${Math.abs(rr.delta)} ${dir} · ${pts} win${
        pts === 1 ? "" : "s"
      }`;
    } else {
      els.rankRevealMeta.textContent = `${pts} win${
        pts === 1 ? "" : "s"
      } · same place`;
    }
  }
}

let lastFinalistsKey = "";

function renderFinalistsReveal() {
  if (!els.finalistsReveal) return;
  const show = game.phase === "qualifying_complete";
  els.finalistsReveal.hidden = !show;
  els.finalistsReveal.classList.toggle("show", show);
  if (!show) return;

  const list = game.qualified || [];
  const liveAt = game.finalLiveAt;
  if (els.finalistsTitle) els.finalistsTitle.textContent = "QUALIFIED FOR FINAL";
  if (els.finalistsLive) {
    els.finalistsLive.textContent = "Final starts next";
  }
  if (els.finalistsCount) {
    els.finalistsCount.textContent = `${list.length} finalist${list.length === 1 ? "" : "s"}`;
  }

  const key = `${liveAt}:${list.map((f) => f.code).join(",")}`;
  if (key === lastFinalistsKey || !els.finalistsScroll) return;
  lastFinalistsKey = key;

  els.finalistsScroll.innerHTML = "";
  const mkRow = () => {
    const row = document.createElement("div");
    row.className = "finalists-row";
    for (const f of list) {
      const cell = document.createElement("div");
      cell.className = "finalists-cell";
      cell.innerHTML = `<img src="${f.img}" alt="" /><span>${f.name}</span>`;
      row.appendChild(cell);
    }
    return row;
  };
  if (!list.length) {
    els.finalistsScroll.textContent = "No finalists";
    return;
  }
  // Duplicate rows for seamless vertical + horizontal scroll coverage.
  for (let i = 0; i < 4; i++) {
    const row = mkRow();
    els.finalistsScroll.appendChild(row);
    els.finalistsScroll.appendChild(mkRow());
  }
}

function clearFighters() {
  fighterEls.forEach((el) => el.remove());
  fighterEls.clear();
  lastBoardKey = "";
  lastEventAt = 0;
  lastSize = 0;
  boardView = BOARD_VIEW_LIVE;
  clearBoardRotateTimer();
  els.feed.innerHTML = "";
}

function renderStreamLinks() {
  // QR overlay removed — poll/rankings links are posted to live chat instead.
  if (els.streamLinks) els.streamLinks.hidden = true;
  void lastLinkKey;
  void pageUrl;
}

function shouldShowStreamPoll() {
  if (!game.stream?.id) return false;
  if (game.phase === "idle") return false;
  if (game.phase === "finished" && !game.winner && game.streamMode !== "final") {
    return true;
  }
  return (
    game.phase === "sprint" ||
    game.phase === "main" ||
    game.phase === "invasion" ||
    game.phase === "qualifying" ||
    game.phase === "between_rounds" ||
    game.phase === "qualifying_hold" ||
    game.phase === "qualifying_complete" ||
    game.phase === "final" ||
    (game.phase === "finished" && Boolean(game.winner))
  );
}

const SPAWN_HINT = "👉 TYPE A COUNTRY CODE IN CHAT TO SPAWN! 🏆";
const VOTE_HINT = "TYPE A COUNTRY OR !VOTE";

function fitHintIntoParent(el) {
  if (!el) return;
  const parent = el.parentElement;
  if (!parent) return;
  // Grow to fill available width; shrink until it fits the hint strip.
  const maxPx = Math.min(42, Math.max(18, parent.clientWidth * 0.095));
  let size = maxPx;
  el.style.fontSize = `${size}px`;
  el.style.whiteSpace = "normal";
  // Cap height so it doesn't steal the whole column.
  const maxH = Math.max(28, parent.clientHeight * 0.22);
  let guard = 40;
  while (
    guard-- > 0 &&
    size > 12 &&
    (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > maxH)
  ) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

function applySprintHudCopy() {
  const spawn = isSpawnVotePhase();
  if (els.streamRecentVotesHead) {
    els.streamRecentVotesHead.textContent = spawn ? "RECENT SPAWNS" : "RECENT VOTES";
  }
  if (els.streamRecentVotesHint) {
    els.streamRecentVotesHint.textContent = spawn ? SPAWN_HINT : VOTE_HINT;
    fitHintIntoParent(els.streamRecentVotesHint);
  }
  if (els.streamShoutoutHead) {
    els.streamShoutoutHead.textContent = spawn ? "TOP SPAWNERS" : "SHOUTOUT ZONE";
  }
  if (els.streamShoutoutHint) {
    if (spawn) {
      els.streamShoutoutHint.innerHTML =
        `<span class="shoutout-hint-main">5 VOTES = BIG FLAG!</span>` +
        `<span class="shoutout-hint-sep" aria-hidden="true">·</span>` +
        `<span class="shoutout-hint-sub">SUBSCRIBE FOR MORE FLAG BATTLES!</span>`;
    } else {
      els.streamShoutoutHint.textContent = "TYPE YOUR COUNTRY TO GET FEATURED!";
    }
    fitHintIntoParent(els.streamShoutoutHint);
  }
}

/** Chat votes spawn/revive during Opening + Main + Invasion. */
let sprintSpawnEndsAt = 0;
let sprintLastVoteAt = 0;

function applySprintSpawnsFromPoll(poll) {
  if (!isSpawnVotePhase() || typeof game.spawnSprintCountry !== "function") {
    return;
  }
  const phaseKey =
    game.phase === "sprint"
      ? game.sprintEndsAt
      : game.phase === "main"
        ? game.mainEndsAt
        : game.phase === "invasion"
          ? "invasion"
          : 1;
  if (phaseKey !== sprintSpawnEndsAt) {
    sprintSpawnEndsAt = phaseKey;
    // Do NOT reset to 0 — that re-applies old recentVotes on Opening→Main.
    // Only brand-new votes (at > watermark) should spawn.
    const recent = Array.isArray(poll?.recentVotes) ? poll.recentVotes : [];
    const newest = recent.reduce(
      (m, r) => Math.max(m, Number(r?.at) || 0),
      sprintLastVoteAt || 0
    );
    sprintLastVoteAt = newest || Date.now();
  }
  const recent = Array.isArray(poll?.recentVotes) ? poll.recentVotes : [];
  const fresh = recent
    .filter((r) => r?.code && (Number(r.at) || 0) > sprintLastVoteAt)
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  for (const r of fresh) {
    game.spawnSprintCountry(r.code, {
      voter: r.voter || "",
      voterId: r.voterId || "",
      avatar: r.avatar || "",
    });
    sprintLastVoteAt = Math.max(sprintLastVoteAt, Number(r.at) || 0);
  }
}

function renderStreamPoll(poll) {
  if (!els.streamPoll || !els.streamPollRows) return;
  if (!shouldShowStreamPoll()) {
    els.streamPoll.hidden = true;
    renderRecentVotes(null);
    return;
  }

  applySprintSpawnsFromPoll(poll);

  const options = poll?.options?.length
    ? poll.options
    : (game.qualified || []).map((q) => ({
        code: q.code,
        name: q.name,
        img: q.img,
      }));

  // Opening / Main / Invasion: spawn panel; hide dense poll bars.
  if (isSpawnVotePhase()) {
    els.streamPoll.hidden = true;
    renderRecentVotes(poll || { recentVotes: [] });
    return;
  }

  if (!options.length) {
    els.streamPoll.hidden = true;
    renderRecentVotes(poll || { recentVotes: [] });
    return;
  }

  els.streamPoll.hidden = false;
  renderRecentVotes(poll);
  const votes = poll?.votes || {};
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  els.streamPollTotal.textContent = `${total} vote${total === 1 ? "" : "s"}`;

  const ranked = [...options].sort(
    (a, b) => (votes[b.code] || 0) - (votes[a.code] || 0)
  );
  const top = ranked.slice(0, 5);
  const key = top.map((o) => `${o.code}:${votes[o.code] || 0}`).join("|") + `:${total}`;
  if (key === lastPollKey) return;
  lastPollKey = key;

  els.streamPollRows.innerHTML = "";
  for (const opt of top) {
    const count = votes[opt.code] || 0;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "stream-poll-row";
    row.innerHTML = `
      <img src="${opt.img || `https://flagcdn.com/w80/${opt.code}.png`}" alt="" />
      <div class="name">${opt.name}</div>
      <div class="count">${count}</div>
      <div class="stream-poll-bar"><i style="width:${pct}%"></i></div>
    `;
    els.streamPollRows.appendChild(row);
  }
}

let lastRecentKey = "";
let shoutoutPool = [];
let shoutoutShownId = "";
let shoutoutUntil = 0;
let shoutoutTickStarted = false;

function formatShoutoutTimer(msLeft) {
  const sec = Math.max(0, Math.ceil(msLeft / 1000));
  return `${sec}s`;
}

function updateShoutoutTimerDisplay() {
  const el = els.streamShoutoutTimer;
  if (!el) return;
  if (!shoutoutShownId || !shoutoutUntil) {
    el.hidden = true;
    return;
  }
  const left = shoutoutUntil - Date.now();
  if (left <= 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = formatShoutoutTimer(left);
}

function renderRecentVotes(poll) {
  if (!els.streamRecentVotes || !els.streamRecentVotesRows) return;
  if (!shouldShowStreamPoll()) {
    els.streamRecentVotes.hidden = true;
    return;
  }
  applySprintHudCopy();
  const spawn = isSpawnVotePhase();
  const recent = spawn
    ? (Array.isArray(game.recentSpawns) ? game.recentSpawns.slice(0, 4) : [])
    : Array.isArray(poll?.recentVotes)
      ? poll.recentVotes.slice(0, 4)
      : [];
  els.streamRecentVotes.hidden = false;
  const key = `${spawn ? "s" : "v"}:` + (recent.length
    ? recent.map((r) => `${r.voterId || r.voter}:${r.code}:${r.at}`).join("|")
    : "__empty__");
  if (key !== lastRecentKey) {
    lastRecentKey = key;
    els.streamRecentVotesRows.innerHTML = "";
    if (!recent.length) {
      const empty = document.createElement("div");
      empty.className = "stream-recent-vote-empty";
      empty.textContent = spawn
        ? "Waiting for chat spawns…"
        : "Waiting for votes…";
      els.streamRecentVotesRows.appendChild(empty);
    } else {
      for (const r of recent) {
        const row = document.createElement("div");
        row.className = "stream-recent-vote";
        const who = String(r.voter || "Viewer").replace(/^@/, "");
        row.innerHTML = `
      <img src="${r.img || `https://flagcdn.com/w40/${r.code}.png`}" alt="" />
      <div class="who">@${who}</div>
      <div class="pick">${r.name || String(r.code || "").toUpperCase()}</div>
    `;
        els.streamRecentVotesRows.appendChild(row);
      }
    }
  }

  updateShoutoutPool(poll);
  renderShoutoutCard(false);
  ensureShoutoutTicker();
}

function updateShoutoutPool(poll) {
  const spawn = isSpawnVotePhase();
  const list = [];
  // Spawn phases: total successful chat spawns this stream (not just alive flags).
  if (spawn && game.spawnTally instanceof Map && game.spawnTally.size) {
    for (const [id, s] of game.spawnTally.entries()) {
      const count = Number(s?.count) || 0;
      if (count < 1) continue;
      list.push({
        id,
        name: String(s.name || id).replace(/^@/, "").slice(0, 40),
        avatar: String(s.avatar || ""),
        count,
      });
    }
  }
  const stats = poll?.voterStats && typeof poll.voterStats === "object"
    ? poll.voterStats
    : null;
  // Merge poll voterStats when taller (e.g. votes that landed before tally existed).
  if (spawn && stats) {
    const byId = new Map(list.map((v) => [v.id, v]));
    for (const [id, s] of Object.entries(stats)) {
      const count = Number(s?.count) || 0;
      if (count < 1) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, {
          id,
          name: String(s.name || id).replace(/^@/, "").slice(0, 40),
          avatar: String(s.avatar || ""),
          count,
        });
      } else {
        prev.count = Math.max(prev.count, count);
        if (s.name) prev.name = String(s.name).replace(/^@/, "").slice(0, 40);
        if (s.avatar) prev.avatar = String(s.avatar);
      }
    }
    list.length = 0;
    list.push(...byId.values());
  }
  if (!list.length && stats) {
    for (const [id, s] of Object.entries(stats)) {
      const count = Number(s?.count) || 0;
      if (count < 1) continue;
      list.push({
        id,
        name: String(s.name || id).replace(/^@/, "").slice(0, 40),
        avatar: String(s.avatar || ""),
        count,
      });
    }
  }
  // Fallback: derive from recent votes if stats missing (older polls).
  if (!list.length && Array.isArray(poll?.recentVotes)) {
    const map = new Map();
    for (const r of poll.recentVotes) {
      const id = r.voterId || r.voter;
      if (!id) continue;
      const prev = map.get(id) || {
        id,
        name: String(r.voter || "Viewer").replace(/^@/, ""),
        avatar: r.avatar || "",
        count: 0,
      };
      prev.count += 1;
      if (r.avatar) prev.avatar = r.avatar;
      map.set(id, prev);
    }
    list.push(...map.values());
  }
  shoutoutPool = list;
}

function pickWeightedShoutout(excludeId) {
  const pool = shoutoutPool.filter((v) => v.id !== excludeId);
  const use = pool.length ? pool : shoutoutPool;
  if (!use.length) return null;
  // Weight by vote count — more votes → more likely to appear.
  let total = 0;
  for (const v of use) total += Math.max(1, v.count);
  let roll = Math.random() * total;
  for (const v of use) {
    roll -= Math.max(1, v.count);
    if (roll <= 0) return v;
  }
  return use[use.length - 1];
}

function renderShoutoutCard(forceNew) {
  if (!els.streamShoutoutCard || !els.streamShoutout) return;
  const spawnPhase = isSpawnVotePhase();
  els.streamShoutout.hidden = !spawnPhase;
  if (!spawnPhase) return;

  const top = shoutoutPool
    .slice()
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 3);
  if (!top.length) {
    els.streamShoutoutCard.innerHTML =
      '<div class="stream-shoutout-empty">Waiting for chat spawns</div>';
    return;
  }
  els.streamShoutoutCard.innerHTML = top
    .map(
      (entry, index) => `
        <div class="spawn-leader-row">
          <strong class="spawn-leader-rank">${index + 1}</strong>
          ${entry.avatar
            ? `<img class="spawn-leader-avatar" src="${escapeAttr(entry.avatar)}" alt="" />`
            : `<span class="spawn-leader-avatar spawn-leader-avatar-fallback" aria-hidden="true">${escapeHtml((entry.name || "?").charAt(0).toUpperCase())}</span>`}
          <span class="spawn-leader-name">@${escapeHtml(entry.name)}</span>
          <span class="spawn-leader-count">${entry.count}</span>
        </div>`
    )
    .join("");
}

function ensureShoutoutTicker() {
  if (shoutoutTickStarted) return;
  shoutoutTickStarted = true;
  setInterval(() => {
    if (!shouldShowStreamPoll()) return;
    // Refresh total spawn tallies + recent spawn rows.
    if (isSpawnVotePhase()) updateShoutoutPool(null);
    if (Date.now() >= shoutoutUntil) renderShoutoutCard(true);
    else {
      renderShoutoutCard(false);
      updateShoutoutTimerDisplay();
    }
  }, 250);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

async function refreshStreamPoll() {
  if (!shouldShowStreamPoll() || !game.stream?.id) {
    if (els.streamPoll) els.streamPoll.hidden = true;
    if (els.streamRecentVotes) els.streamRecentVotes.hidden = true;
    return;
  }
  const poll = await fetchPoll(game.stream.id);
  renderStreamPoll(poll);
}

function renderChrome() {
  renderBoard();
  renderFeed();
  renderHud();
  refreshStreamPoll();
}

els.btnStart.addEventListener("click", () => {
  unlockAudio();
  clearFighters();
  Promise.resolve(game.start()).catch((err) => {
    console.error(err);
  });
});

els.btnReset.addEventListener("click", () => {
  clearFighters();
  game.reset();
  syncArena();
  renderChrome();
});

const mobileMode = params.has("mobile") || params.has("stream");

if (params.has("stream")) document.body.classList.add("stream-mode");
if (params.has("mobile")) document.body.classList.add("mobile-mode");

game.onFrame = syncArena;
game.onChange = renderChrome;
game.reset();
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
syncArena();
renderChrome();
ensureChampionshipTop10Refresh();

if (params.has("autostart")) {
  unlockAudio();
  clearFighters();
  Promise.resolve(game.start()).catch((err) => {
    console.error(err);
  });
}

// Unlock Web Audio (ambient + SFX). Stream Chrome has no real gesture — keep retrying.
window.addEventListener(
  "pointerdown",
  () => unlockAudio(),
  { once: true, passive: true }
);
window.addEventListener(
  "keydown",
  () => unlockAudio(),
  { once: true, passive: true }
);
if (params.has("stream") || params.has("autostart")) {
  ensureStreamAudio();
} else {
  setTimeout(() => unlockAudio(), 800);
}

// Keep on-stream poll board fresh for viewers.
clearInterval(pollTimer);
pollTimer = setInterval(() => {
  renderStreamLinks();
  refreshStreamPoll();
}, 2000);
window.addEventListener("resize", () => {
  layoutSquareArena();
  syncArena();
  fitHintIntoParent(els.streamRecentVotesHint);
  fitHintIntoParent(els.streamShoutoutHint);
});

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
    /* ignore */
  }
}

enableMobileStreamHelpers();
