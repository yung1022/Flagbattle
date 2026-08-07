import { FlagBattleGame, CONFIG, flagSizeForCount, IS_TEST_STREAM, TEST_STREAM } from "./game.js";
import { COUNTRIES } from "./countries.js";
import { fetchPoll } from "./store.js";
import { siteBase as resolveSiteBase } from "./public.js";
import { announceRoundWinner, unlockAudio } from "./sfx.js";

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

    const battling =
      (game.finalStage === "swiss" || game.finalStage === "battle") &&
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

function isSprintPhase() {
  return (
    game.phase === "sprint" ||
    (game.phase === "between_rounds" &&
      (game._pendingSprintReset || game._pendingSprintEnd))
  );
}

function renderBoard() {
  const flags = game.boardFlags();
  const sprintBoard = isSprintPhase();
  const qualBoard =
    !sprintBoard &&
    game.streamMode !== "final" &&
    (game.phase === "qualifying" ||
      game.phase === "qualifying_hold" ||
      game.phase === "qualifying_complete" ||
      game.phase === "idle" ||
      game.phase === "between_rounds" ||
      (game.phase === "finished" && !game.winner));

  if (sprintBoard) {
    els.boardLabel.textContent = "SPRINT WINS";
    els.boardMeta.textContent = flags.length
      ? `${flags.length} win${flags.length === 1 ? "" : "s"} · no points`
      : "Type a country to spawn";
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

  const key = `${game.phase}:${game.finalStage}:${game.swissRound}:${flags
    .map((f) => `${f.code}:${f.points ?? ""}`)
    .join(",")}`;
  if (key === lastBoardKey) return;
  lastBoardKey = key;

  els.boardTrack.classList.toggle(
    "marquee",
    document.body.classList.contains("stream-mode")
      ? flags.length > 4
      : flags.length > 8
  );
  els.boardTrack.innerHTML = "";

  if (!flags.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = sprintBoard
      ? "No sprint wins yet — last flag standing wins the round"
      : game.phase === "qualifying" ||
          game.phase === "between_rounds" ||
          game.phase === "qualifying_hold"
        ? "Waiting for first qualifier…"
        : game.phase === "idle"
          ? "Press Start — Sprint then Qualifying → Final"
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
    const pts = Number(f.points);
    name.textContent =
      Number.isFinite(pts) && (game._swissBoardActive?.() || game.finalStage === "swiss")
        ? `${f.name} · ${pts}`
        : f.name;
    chip.appendChild(img);
    chip.appendChild(name);
    row.appendChild(chip);
  }
  els.boardTrack.appendChild(row);
  const needScroll = els.boardTrack.classList.contains("marquee");
  if (needScroll) {
    const clone = row.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    els.boardTrack.appendChild(clone);
    // Pace scroll by list length so long boards stay readable.
    const secs = Math.min(48, Math.max(14, flags.length * 1.6));
    els.boardTrack.style.setProperty("--board-scroll-s", `${secs}s`);
  } else {
    els.boardTrack.style.removeProperty("--board-scroll-s");
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
    if (game.phase === "idle") els.roundMeta.textContent = "Sprint → Qualifying → Final";
    else if (isSprintPhase())
      els.roundMeta.textContent =
        "Sprint · smaller hole · type a country to spawn · wins unscored";
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
    els.phaseText.textContent = "Sprint";
    els.timer.textContent = formatMs(game.sprintRemainingMs());
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
  // Sprint + Qualifying through Final (closes after champion).
  if (game.phase === "idle") return false;
  if (game.phase === "finished" && !game.winner && game.streamMode !== "final") {
    return true;
  }
  return (
    game.phase === "sprint" ||
    game.phase === "qualifying" ||
    game.phase === "between_rounds" ||
    game.phase === "qualifying_hold" ||
    game.phase === "qualifying_complete" ||
    game.phase === "final" ||
    (game.phase === "finished" && Boolean(game.winner))
  );
}

function applySprintHudCopy() {
  const sprint = isSprintPhase();
  if (els.streamRecentVotesHead) {
    els.streamRecentVotesHead.textContent = sprint ? "RECENT SPAWNS" : "RECENT VOTES";
  }
  if (els.streamRecentVotesHint) {
    els.streamRecentVotesHint.textContent = sprint
      ? "TYPE A COUNTRY TO SPAWN"
      : "TYPE A COUNTRY OR !VOTE";
  }
  if (els.streamShoutoutHead) {
    els.streamShoutoutHead.textContent = sprint ? "SPAWN ZONE" : "SHOUTOUT ZONE";
  }
  if (els.streamShoutoutHint) {
    els.streamShoutoutHint.textContent = sprint
      ? "TYPE YOUR COUNTRY TO SPAWN!"
      : "TYPE YOUR COUNTRY TO GET FEATURED!";
  }
}

/** Chat votes during Sprint also revive/spawn that country in the arena. */
let sprintSpawnEndsAt = 0;
let sprintLastVoteAt = 0;

function applySprintSpawnsFromPoll(poll) {
  if (game.phase !== "sprint" || typeof game.spawnSprintCountry !== "function") {
    return;
  }
  if (game.sprintEndsAt !== sprintSpawnEndsAt) {
    sprintSpawnEndsAt = game.sprintEndsAt;
    sprintLastVoteAt = 0;
  }
  const recent = Array.isArray(poll?.recentVotes) ? poll.recentVotes : [];
  const fresh = recent
    .filter((r) => r?.code && (Number(r.at) || 0) > sprintLastVoteAt)
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  for (const r of fresh) {
    game.spawnSprintCountry(r.code, {
      voter: r.voter || "",
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

  // During Sprint: show spawn panel, hide Final poll bars.
  if (isSprintPhase()) {
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

function renderRecentVotes(poll) {
  if (!els.streamRecentVotes || !els.streamRecentVotesRows) return;
  if (!shouldShowStreamPoll()) {
    els.streamRecentVotes.hidden = true;
    return;
  }
  applySprintHudCopy();
  const sprint = isSprintPhase();
  const recent = sprint
    ? (Array.isArray(game.recentSpawns) ? game.recentSpawns.slice(0, 4) : [])
    : Array.isArray(poll?.recentVotes)
      ? poll.recentVotes.slice(0, 4)
      : [];
  els.streamRecentVotes.hidden = false;
  const key = `${sprint ? "s" : "v"}:` + (recent.length
    ? recent.map((r) => `${r.voter}:${r.code}:${r.at}`).join("|")
    : "__empty__");
  if (key !== lastRecentKey) {
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

  updateShoutoutPool(poll);
  renderShoutoutCard(false);
  ensureShoutoutTicker();
}

function updateShoutoutPool(poll) {
  const sprint = isSprintPhase();
  const list = [];
  // Sprint: prefer spawners from recentSpawns (chat typed a country).
  if (sprint && Array.isArray(game.recentSpawns) && game.recentSpawns.length) {
    const map = new Map();
    for (const r of game.recentSpawns) {
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
  const stats = poll?.voterStats && typeof poll.voterStats === "object"
    ? poll.voterStats
    : null;
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
  if (!els.streamShoutoutCard) return;
  const now = Date.now();
  const needNew =
    forceNew ||
    !shoutoutShownId ||
    now >= shoutoutUntil ||
    !shoutoutPool.some((v) => v.id === shoutoutShownId);

  if (needNew) {
    const pick = pickWeightedShoutout(shoutoutShownId);
    if (!pick) {
      shoutoutShownId = "";
      els.streamShoutoutCard.innerHTML = `<div class="stream-shoutout-empty">${
        isSprintPhase() ? "Spawn to get featured" : "Vote to get featured"
      }</div>`;
      return;
    }
    shoutoutShownId = pick.id;
    shoutoutUntil = now + 7000;
    const unit = isSprintPhase() ? "spawn" : "vote";
    const initial = (pick.name || "?").trim().charAt(0).toUpperCase() || "?";
    const avatarHtml = pick.avatar
      ? `<img class="stream-shoutout-avatar" src="${escapeAttr(pick.avatar)}" alt="" />`
      : `<div class="stream-shoutout-avatar stream-shoutout-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</div>`;
    els.streamShoutoutCard.innerHTML = `
      ${avatarHtml}
      <div class="stream-shoutout-meta">
        <div class="stream-shoutout-name">@${escapeHtml(pick.name)}</div>
        <div class="stream-shoutout-count">${pick.count} ${unit}${pick.count === 1 ? "" : "s"} this stream</div>
      </div>
    `;
    els.streamShoutoutCard.classList.remove("stream-shoutout-pulse");
    // Retrigger CSS animation
    void els.streamShoutoutCard.offsetWidth;
    els.streamShoutoutCard.classList.add("stream-shoutout-pulse");
    return;
  }

  // Refresh live count for the featured voter without rotating.
  const cur = shoutoutPool.find((v) => v.id === shoutoutShownId);
  if (cur) {
    const countEl = els.streamShoutoutCard.querySelector(".stream-shoutout-count");
    if (countEl) {
      const unit = isSprintPhase() ? "spawn" : "vote";
      countEl.textContent = `${cur.count} ${unit}${cur.count === 1 ? "" : "s"} this stream`;
    }
  }
}

function ensureShoutoutTicker() {
  if (shoutoutTickStarted) return;
  shoutoutTickStarted = true;
  setInterval(() => {
    if (!shouldShowStreamPoll()) return;
    if (Date.now() >= shoutoutUntil) renderShoutoutCard(true);
  }, 1000);
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
