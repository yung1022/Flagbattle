import { FlagBattleGame, CONFIG, flagSizeForCount, IS_TEST_STREAM, TEST_STREAM } from "./game.js";
import { COUNTRIES } from "./countries.js";
import { fetchPoll } from "./store.js";
import { siteBase as resolveSiteBase } from "./public.js";
import { announceRoundWinner, unlockAudio } from "./sfx.js";
import { formatLiveSlot } from "./live-schedule.js";

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
  roundMeta: document.getElementById("round-meta"),
  intermission: document.getElementById("intermission"),
  intermissionTitle: document.getElementById("intermission-title"),
  intermissionSub: document.getElementById("intermission-sub"),
  intermissionTimer: document.getElementById("intermission-timer"),
  streamLink: document.getElementById("stream-link"),
  streamLinks: document.getElementById("stream-links"),
  streamPoll: document.getElementById("stream-poll"),
  streamPollRows: document.getElementById("stream-poll-rows"),
  streamPollTotal: document.getElementById("stream-poll-total"),
  streamRecentVotes: document.getElementById("stream-recent-votes"),
  streamRecentVotesRows: document.getElementById("stream-recent-votes-rows"),
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

  const showAllAlive =
    game.phase === "intermission" || game.phase === "qualifying_hold";
  const visibleIds = new Set();

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
    if (sizeChanged) el.style.setProperty("--size", `${sizeBase}px`);
    const x = f.x * w;
    const y = f.y * h;
    const scale = f.pulse > 0.2 ? 1.12 : 1;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`;
    if (el.classList.contains("falling") !== f.falling) {
      el.classList.toggle("falling", f.falling);
    }

    const bar = el.querySelector(".hp-bar");
    if (bar) {
      const showHp =
        (game.finalStage === "swiss" || game.finalStage === "battle") &&
        f.alive &&
        !f.falling;
      bar.hidden = !showHp;
      if (showHp) {
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
  }

  if (fighterEls.size !== visibleIds.size) {
    for (const [id, el] of fighterEls) {
      if (!visibleIds.has(id) && !el.classList.contains("eliminating")) {
        el.remove();
        fighterEls.delete(id);
      }
    }
  }
}

function renderBoard() {
  const flags = game.boardFlags();
  const qualBoard =
    game.streamMode !== "final" &&
    (game.phase === "qualifying" ||
      game.phase === "qualifying_hold" ||
      game.phase === "qualifying_complete" ||
      game.phase === "idle" ||
      game.phase === "between_rounds" ||
      (game.phase === "intermission" && game.intermissionKind === "open") ||
      (game.phase === "finished" && !game.winner));

  if (game.streamMode === "final") {
    if (game.phase === "finished" && game.winner) {
      els.boardLabel.textContent = "CHAMPION";
      els.boardMeta.textContent = game.winner.name;
    } else if (game.finalStage === "swiss") {
      els.boardLabel.textContent = "SWISS 1V1";
      els.boardMeta.textContent = `Round ${game.swissRound + 1}/${CONFIG.swissRounds}`;
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

  const key = `${game.phase}:${game.finalStage}:${flags.map((f) => f.code).join(",")}`;
  if (key === lastBoardKey) return;
  lastBoardKey = key;

  els.boardTrack.classList.toggle("marquee", flags.length > 8);
  els.boardTrack.innerHTML = "";

  if (!flags.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent =
      game.phase === "intermission" && game.intermissionKind === "open"
        ? "Qualifying starts after intermission…"
        : game.phase === "qualifying" ||
            game.phase === "between_rounds" ||
            game.phase === "qualifying_hold"
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
    const chip = document.createElement("div");
    chip.className = "board-chip";
    const img = document.createElement("img");
    img.className = "board-flag";
    img.src = f.img;
    img.alt = f.name;
    img.title = f.name;
    const name = document.createElement("span");
    name.className = "board-chip-name";
    name.textContent = f.name;
    chip.appendChild(img);
    chip.appendChild(name);
    row.appendChild(chip);
  }
  els.boardTrack.appendChild(row);
  if (flags.length > 8) {
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
  maybeAnnounce(latest);
}

function maybeAnnounce(event) {
  if (!event || event.at === lastAnnouncedAt) return;
  lastAnnouncedAt = event.at;
  if (event.type === "qualify") {
    const name =
      game.qualified?.[game.qualified.length - 1]?.name ||
      String(event.text || "").split(" ")[0] ||
      "A country";
    announceRoundWinner(name, { champion: false });
  } else if (event.type === "winner") {
    announceRoundWinner(game.winner?.name || "Champion", { champion: true });
  }
}

function renderHud() {
  const fighting = game.standing().length;
  const inFinal =
    game.streamMode === "final" ||
    game.phase === "final" ||
    (game.phase === "between_rounds" && game.finalStage);

  els.statCountries.textContent = String(COUNTRIES.length);
  els.statFighting.textContent = String(
    game.phase === "intermission"
      ? game.fighters.filter((f) => f.alive).length
      : fighting
  );
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
    badge.textContent = `TEST · ${TEST_STREAM} · no save`;
    badge.hidden = false;
  } else if (badge) {
    badge.hidden = true;
  }

  if (els.roundMeta) {
    if (game.phase === "idle") els.roundMeta.textContent = "Hole circle · no damage";
    else if (game.phase === "intermission")
      els.roundMeta.textContent =
        game.intermissionKind === "final"
          ? "Intermission · Final next"
          : "Intermission · Qualifying next";
    else if (game.phase === "qualifying_hold")
      els.roundMeta.textContent = "All qualified · waiting on clock";
    else if (game.phase === "qualifying_complete")
      els.roundMeta.textContent = "Finalists locked · see overlay";
    else if (inFinal && game.finalStage === "swiss")
      els.roundMeta.textContent = `Swiss 1v1 · Round ${game.swissRound + 1}/${CONFIG.swissRounds}`;
    else if (inFinal && game.finalStage === "battle")
      els.roundMeta.textContent = `Final battle · 100 HP · −${CONFIG.hitDamage}/hit`;
    else if (inFinal && (game.phase === "final" || game.phase === "finished"))
      els.roundMeta.textContent =
        game.finalStage === "hole" || !game.finalStage
          ? `Final hole · reset on fall · Round ${game.round}`
          : `Final · Round ${game.round}`;
    else if (game.phase === "between_rounds" && !inFinal)
      els.roundMeta.textContent = `Qualifying · Round ${game.round}`;
    else els.roundMeta.textContent = `Qualifying · Round ${game.round}`;
  }

  if (game.phase === "intermission") {
    els.phaseText.textContent = "Intermission";
    els.timer.textContent = formatMs(game.intermissionRemainingMs());
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
      els.phaseText.textContent = "Champion";
      els.timer.hidden = true;
    }
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
      els.intermissionTitle.textContent = opening ? "GET READY" : "FINAL INCOMING";
      els.intermissionSub.textContent = opening
        ? `${COUNTRIES.length} countries · hole circle qualifying`
        : `${game.qualified.length} qualified · hole → Swiss 1v1 → last standing`;
      els.intermissionTimer.textContent = formatMs(game.intermissionRemainingMs());
    }
  }

  renderFinalistsReveal();

  if (els.streamLink && game.stream?.id) {
    els.streamLink.hidden = false;
    els.streamLink.href = `rankings.html?id=${encodeURIComponent(game.stream.id)}`;
    els.streamLink.textContent = "Rankings";
  }

  renderStreamLinks();

  const busy =
    game.phase === "qualifying" ||
    game.phase === "qualifying_hold" ||
    game.phase === "qualifying_complete" ||
    game.phase === "between_rounds" ||
    game.phase === "intermission" ||
    game.phase === "final";
  els.btnStart.disabled = busy;
  els.btnStart.textContent =
    game.phase === "finished" ||
    game.phase === "idle" ||
    game.phase === "qualifying_complete"
      ? "Start Battle"
      : "In Progress";

  if (game.phase === "finished" && game.winner) {
    els.winnerBanner.classList.add("show");
    els.winnerFlag.src = game.winner.img;
    els.winnerFlag.alt = game.winner.name;
    els.winnerName.textContent = game.winner.name;
  } else {
    els.winnerBanner.classList.remove("show");
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
    els.finalistsLive.textContent = `Final live · ${formatLiveSlot(liveAt)}`;
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
  els.feed.innerHTML = "";
}

function renderStreamLinks() {
  // QR overlay removed — poll/rankings links are posted to live chat instead.
  if (els.streamLinks) els.streamLinks.hidden = true;
  void lastLinkKey;
  void pageUrl;
}

function shouldShowStreamPoll() {
  if (IS_TEST_STREAM) return false;
  if (!game.stream?.id) return false;
  // Available from Qualifying through Final (closes after champion).
  if (game.phase === "idle") return false;
  if (game.phase === "finished" && !game.winner && game.streamMode !== "final") {
    // Qualifying complete overlay — still show poll
    return true;
  }
  return (
    game.phase === "intermission" ||
    game.phase === "qualifying" ||
    game.phase === "between_rounds" ||
    game.phase === "qualifying_hold" ||
    game.phase === "qualifying_complete" ||
    game.phase === "final" ||
    (game.phase === "finished" && Boolean(game.winner))
  );
}

function renderStreamPoll(poll) {
  if (!els.streamPoll || !els.streamPollRows) return;
  if (!shouldShowStreamPoll()) {
    els.streamPoll.hidden = true;
    renderRecentVotes(null);
    return;
  }

  const options = poll?.options?.length
    ? poll.options
    : (game.qualified || []).map((q) => ({
        code: q.code,
        name: q.name,
        img: q.img,
      }));

  if (!options.length) {
    els.streamPoll.hidden = true;
    renderRecentVotes(null);
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

function renderRecentVotes(poll) {
  if (!els.streamRecentVotes || !els.streamRecentVotesRows) return;
  if (!shouldShowStreamPoll()) {
    els.streamRecentVotes.hidden = true;
    return;
  }
  const recent = Array.isArray(poll?.recentVotes) ? poll.recentVotes.slice(0, 5) : [];
  if (!recent.length) {
    els.streamRecentVotes.hidden = true;
    return;
  }
  els.streamRecentVotes.hidden = false;
  const key = recent.map((r) => `${r.voter}:${r.code}:${r.at}`).join("|");
  if (key === lastRecentKey) return;
  lastRecentKey = key;

  els.streamRecentVotesRows.innerHTML = "";
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

if (params.has("autostart")) {
  unlockAudio();
  clearFighters();
  Promise.resolve(game.start()).catch((err) => {
    console.error(err);
  });
}

// Headless Chrome / stream: unlock audio once the page is interactive.
window.addEventListener(
  "pointerdown",
  () => unlockAudio(),
  { once: true, passive: true }
);
setTimeout(() => unlockAudio(), 800);

// Keep on-stream poll board fresh for viewers.
clearInterval(pollTimer);
pollTimer = setInterval(() => {
  renderStreamLinks();
  refreshStreamPoll();
}, 2000);
window.addEventListener("resize", () => {
  layoutSquareArena();
  syncArena();
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
