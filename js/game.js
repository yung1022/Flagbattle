import { COUNTRIES, flagUrl } from "./countries.js";
import {
  newStreamId,
  saveStream,
  setLiveSnapshot,
  initLocalPoll,
  transferPoll,
  closeLocalPoll,
  getLocalPoll,
  rankPollPlaces,
  fetchStreamsFromApi,
  listStreams,
  setPersistEnabled,
  seedTeststreamPollDemo,
  startTeststreamChatVoteDemo,
} from "./store.js";
import { resolveApiBase, pagesDataUrl } from "./public.js";
import { parseVoteMessage } from "./vote-message.js";
import {
  averageQualifyingRating,
  computeWinRankReveal,
} from "./rankings-stats.js";
import { playSfx } from "./sfx.js";

/**
 * @typedef {"idle" | "sprint" | "main" | "invasion" | "qualifying" | "qualifying_hold" | "between_rounds" | "final" | "qualifying_complete" | "finished"} Phase
 * @typedef {"qualifying" | "final"} StreamMode
 * @typedef {"hole" | "swiss" | "battle" | "main" | "invasion" | null} FinalStage
 * @typedef {"full" | "opening" | "sprint" | "main" | "invasion" | "hole" | "swiss" | "final4" | null} TestStreamKind
 * @typedef {"saw" | "blackhole" | "catch" | null} ArenaEventType
 */

const params = new URLSearchParams(location.search);

/** Easy/teststream: full = Opening → Main → Invasion. Stage shortcuts available. */
export function normalizeTestStream(raw) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (
    v === "" ||
    v === "1" ||
    v === "true" ||
    v === "qual" ||
    v === "qualifying" ||
    v === "full" ||
    v === "battle" ||
    v === "all"
  ) {
    return "full";
  }
  if (v === "sprint" || v === "opening" || v === "spawn" || v === "phase1") {
    return "opening";
  }
  if (v === "main" || v === "phase2" || v === "events") return "main";
  if (v === "invasion" || v === "alien" || v === "phase3" || v === "end") {
    return "invasion";
  }
  if (v === "hole" || v === "final" || v === "final1" || v === "part1") return "hole";
  if (v === "swiss" || v === "part2") return "swiss";
  if (v === "final4" || v === "last" || v === "part3") return "final4";
  return "full";
}

export const TEST_STREAM = params.has("teststream")
  ? normalizeTestStream(params.get("teststream"))
  : null;
export const IS_TEST_STREAM = Boolean(TEST_STREAM);

if (IS_TEST_STREAM) {
  // Easy path: never write rankings / live / polls / local config.
  setPersistEnabled(false);
}

const STREAM_MODE =
  TEST_STREAM === "hole" || TEST_STREAM === "swiss" || TEST_STREAM === "final4"
    ? "final"
    : String(params.get("mode") || "qualifying").toLowerCase() === "final"
      ? "final"
      : "qualifying";

export const CONFIG = {
  qualifyingMs: 30 * 60 * 1000,
  /** Opening (Sprint-like): all flags, chat spawn/vote, smaller hole. */
  sprintMs: 15 * 60 * 1000,
  /** Main arena: HP + random events (50–60 minutes). */
  mainMsMin: 50 * 60 * 1000,
  mainMsMax: 60 * 60 * 1000,
  /** Random event duration. */
  eventDurationMs: 30 * 1000,
  /** Gap until next event (random in range). */
  eventGapMinMs: 40 * 1000,
  eventGapMaxMs: 120 * 1000,
  /** Every N chat votes/spawns → grow that flag. */
  votesPerBigFlag: 5,
  bigFlagScaleStep: 0.55,
  bigFlagScaleMax: 2.6,
  /** Alien invasion DPS (HP/sec while near an alien). */
  alienDps: 18,
  alienCount: 5,
  /** Opening hole aperture (radians) — small; big flags still fit via size pad. */
  sprintHoleWidth: 0.28,
  /** Circular saw radius (arena units) + contact pad. */
  sawRadius: 0.055,
  /** Qualifying rim — must match CSS --rim / SVG circle. */
  arenaRadius: 0.42,
  /** Final hole stage — larger circle; UI chrome is tightened to fit. */
  finalArenaRadius: 0.48,
  holeWidth: 0.52,
  holeSpeed: 1.8,
  /** Final: keep hole shut, then open gradually. */
  holeClosedSec: 5,
  holeOpenSec: 28,
  flagRadius: 0.028,
  maxSpeed: 1.15,
  /** Swiss 1v1 moves faster than hole / Final 4. */
  swissSpeedMult: 1.7,
  betweenRoundMs: 1400,
  pushStrength: 0.8,
  outwardForce: 0.35,
  shrinkMinScale: 0.68,
  shrinkDurationSec: 40,
  /** Hole stage stops when this many remain → Swiss battling. */
  swissCutoff: 16,
  /** After Swiss, keep top (swissCutoff - swissEliminate) for last-stand. */
  swissEliminate: 12,
  swissRounds: 5,
  baseHp: 100,
  /** HP lost per collision hit during battling modes. */
  hitDamage: 5,
  /** Min approach speed (along contact normal) to count as a hit. */
  hitSpeedMin: 0.22,
  hitCooldownSec: 0.35,
  battleRate: 2.2,
  /**
   * Swiss / Final 4: downward gravity (arena y increases downward).
   * Strong enough to pull fights toward the bottom of the circle.
   */
  battleGravity: 0.85,
  /** Swiss / Final 4: lighter center push so gravity reads clearly. */
  battleOutwardForce: 0.1,
  /**
   * Swiss / Final 4: if a bounce leaves a flag slower than this fraction of
   * max speed, nudge it back up so fights don't stall.
   */
  battleMinBounceSpeed: 0.78,
  /** Extra multiply applied on slow battle bounces (rim or flag). */
  battleBounceBoost: 1.55,
  /** After Final champion, keep the winner on screen before ending the stream. */
  winnerHoldMs: 60 * 1000,
  /** Full-screen rank-change reveal after a whole-game win (pauses combat). */
  winRevealMs: 3000,
  /** Brief finalists reveal before Final starts in the same livestream. */
  finalistsRevealMs: 12 * 1000,
  /** Skip full UI notifications; physics still every frame. */
  uiThrottleMs: 250,
};

function applyEasyTestConfig() {
  CONFIG.qualifyingMs = 90 * 1000;
  CONFIG.sprintMs = 25 * 1000;
  CONFIG.mainMsMin = 45 * 1000;
  CONFIG.mainMsMax = 55 * 1000;
  CONFIG.eventDurationMs = 8 * 1000;
  CONFIG.eventGapMinMs = 6 * 1000;
  CONFIG.eventGapMaxMs = 12 * 1000;
  CONFIG.sprintHoleWidth = 0.32;
  CONFIG.betweenRoundMs = 500;
  CONFIG.holeSpeed = 2.4;
  CONFIG.holeWidth = 0.58;
  CONFIG.maxSpeed = 1.45;
  CONFIG.outwardForce = 0.5;
  CONFIG.shrinkDurationSec = 14;
  CONFIG.holeClosedSec = 2;
  CONFIG.holeOpenSec = 8;
  CONFIG.swissRounds = 5;
  CONFIG.swissSpeedMult = 1.85;
  CONFIG.battleRate = 5;
  CONFIG.alienDps = 35;
  CONFIG.finalistsRevealMs = 4 * 1000;
  CONFIG.winnerHoldMs = 8 * 1000;
}

if (params.has("demo")) {
  const sec = Number(params.get("demo")) || 45;
  CONFIG.qualifyingMs = sec * 1000;
  CONFIG.betweenRoundMs = 600;
  CONFIG.holeSpeed = 2.4;
  CONFIG.holeWidth = 1.0;
  CONFIG.maxSpeed = 1.45;
  CONFIG.outwardForce = 0.5;
  CONFIG.shrinkDurationSec = 18;
  CONFIG.holeClosedSec = 2;
  CONFIG.holeOpenSec = 10;
  CONFIG.swissRounds = 5;
  CONFIG.swissSpeedMult = 1.85;
  CONFIG.battleRate = 5;
}

if (IS_TEST_STREAM) {
  applyEasyTestConfig();
  if (params.has("demo")) {
    const sec = Number(params.get("demo")) || 45;
    CONFIG.qualifyingMs = sec * 1000;
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
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

export function flagSizeForCount(count) {
  const n = Math.max(1, count);
  const radius = Math.min(0.034, Math.max(0.011, 0.2 / Math.sqrt(n)));
  const px = Math.min(58, Math.max(13, 500 / Math.sqrt(n)));
  return { radius, px };
}

export class FlagBattleGame {
  constructor() {
    /** @type {Phase} */
    this.phase = "idle";
    this.fighters = [];
    this.qualified = [];
    this.eliminated = [];
    this.events = [];
    this.phaseStartedAt = 0;
    this.qualifyingEndsAt = 0;
    this.qualifyingExpired = false;
    this.winner = null;
    this.round = 0;
    this.holeAngle = 0;
    this.roundStartedAt = 0;
    this.arenaScale = 1;
    this.stream = null;
    /** @type {StreamMode} */
    this.streamMode = STREAM_MODE;
    /** @type {FinalStage} */
    this.finalStage = null;
    /** @type {TestStreamKind} */
    this.testStream = null;
    this.swissRound = 0;
    this.finalLiveAt = null;
    this._fallOrder = [];
    /** Swiss players cut before Final 4 (ranked by avg Qual place). */
    this._swissCut = [];
    /** Final 4 elimination order (first elim → earliest in array). */
    this._battleElimOrder = [];
    this._betweenUntil = 0;
    this._pendingQualComplete = false;
    this._pendingSwissCut = false;
    this._pendingSwissNext = false;
    this._pendingSwissPair = false;
    this._pendingFinalReset = false;
    this._finalResetRemaining = null;
    this._finalElimLock = false;
    this._pendingSprintReset = false;
    this._pendingSprintEnd = false;
    this._pendingMainReset = false;
    this.sprintEndsAt = 0;
    this.mainEndsAt = 0;
    /** @type {{ type: ArenaEventType, endsAt: number, angle?: number, hunterCode?: string, label?: string } | null} */
    this.arenaEvent = null;
    this.nextEventAt = 0;
    /** @type {Array<{x:number,y:number,vx:number,vy:number}>} */
    this.aliens = [];
    /** Last-death ranking: code → death index (updated on every death after revive). */
    this._deathSeq = [];
    /** @type {Array<{code:string,name:string,img:string,at:number,voter?:string}>} */
    this.recentSprintWins = [];
    /** Main last-standing points (in-stream; used for final ranking). */
    /** @type {Map<string, number>} */
    this.mainRoundPoints = new Map();
    /** First time each country earned a Main point (earlier = better tiebreak). */
    /** @type {Map<string, number>} */
    this.mainPointAt = new Map();
    /** @type {Array<{code:string,name:string,img:string,at:number,points:number}>} */
    this.recentMainWins = [];
    /** @type {Array<{code:string,name:string,img:string,at:number,voter?:string,avatar?:string}>} */
    this.recentSpawns = [];
    this._swissPairQueue = [];
    this._swissMatchOver = false;
    this._battleAccum = 0;
    this._winnerHoldUntil = 0;
    this._winnerHoldDone = false;
    /** @type {null | {code:string,name:string,img:string,fromRank:number|null,toRank:number,points:number,prevPoints:number,delta:number|null,firstWin:boolean}} */
    this.rankReveal = null;
    this._winRevealUntil = 0;
    this._pendingUnifiedFinal = false;
    this._raf = 0;
    this._lastTs = 0;
    this._lastUi = 0;
    this._uiDirty = true;
    this._stopTeststreamChatDemo = null;
    this.onFrame = () => {};
    this.onChange = () => {};
  }

  reset() {
    this.stopLoop();
    if (typeof this._stopTeststreamChatDemo === "function") {
      this._stopTeststreamChatDemo();
      this._stopTeststreamChatDemo = null;
    }
    this.phase = "idle";
    this.fighters = [];
    this.qualified = [];
    this.eliminated = [];
    this.events = [];
    this.phaseStartedAt = 0;
    this.qualifyingEndsAt = 0;
    this.qualifyingExpired = false;
    this.winner = null;
    this.round = 0;
    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = 0;
    this.arenaScale = 1;
    this.stream = null;
    this.streamMode = STREAM_MODE;
    this.finalStage = null;
    this.testStream = null;
    this.swissRound = 0;
    this.finalLiveAt = null;
    this._fallOrder = [];
    this._swissCut = [];
    this._battleElimOrder = [];
    this._betweenUntil = 0;
    this._pendingQualComplete = false;
    this._pendingSwissCut = false;
    this._pendingSwissNext = false;
    this._pendingSwissPair = false;
    this._pendingFinalReset = false;
    this._finalResetRemaining = null;
    this._finalElimLock = false;
    this._pendingSprintReset = false;
    this._pendingSprintEnd = false;
    this._pendingMainReset = false;
    this.sprintEndsAt = 0;
    this.mainEndsAt = 0;
    this.arenaEvent = null;
    this.nextEventAt = 0;
    this.aliens = [];
    this._deathSeq = [];
    this.recentSprintWins = [];
    this.mainRoundPoints = new Map();
    this.mainPointAt = new Map();
    this.recentMainWins = [];
    this.recentSpawns = [];
    this._swissPairQueue = [];
    this._swissMatchOver = false;
    this._battleAccum = 0;
    this._winnerHoldUntil = 0;
    this._winnerHoldDone = false;
    this.rankReveal = null;
    this._winRevealUntil = 0;
    this._pendingUnifiedFinal = false;
    this._uiDirty = true;
    this._emit(
      "reset",
      "Opening → Main (events) → Alien Invasion. Type a country to spawn / vote."
    );
    this._flushUi(true);
  }

  _makeFighter(country, index, total) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 + rand(-0.04, 0.04);
    const radius = rand(0.05, this.arenaRadiusNow() * 0.68);
    const speed = rand(CONFIG.maxSpeed * 0.45, CONFIG.maxSpeed);
    const dir = rand(0, Math.PI * 2);
    const spawnVotes = Number(country.spawnVotes) || 0;
    return {
      ...country,
      id: `${country.code}-${this.round}-${index}`,
      code: country.code,
      alive: true,
      qualified: false,
      falling: false,
      hp: CONFIG.baseHp,
      maxHp: CONFIG.baseHp,
      points: Number(country.points) || 0,
      spawnVotes,
      sizeMult: this._sizeMultForVotes(spawnVotes),
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      img: flagUrl(country.code, 80),
      hitCd: 0,
    };
  }

  _sizeMultForVotes(votes) {
    const n = Math.max(0, Number(votes) || 0);
    const steps = Math.floor(n / Math.max(1, CONFIG.votesPerBigFlag || 5));
    const step = CONFIG.bigFlagScaleStep ?? 0.55;
    const max = CONFIG.bigFlagScaleMax ?? 2.6;
    return Math.min(max, 1 + steps * step);
  }

  arenaRadiusNow() {
    if (
      this.phase === "main" ||
      this.phase === "invasion" ||
      this.finalStage === "main" ||
      this.finalStage === "invasion" ||
      this.streamMode === "final" ||
      this.finalStage
    ) {
      return CONFIG.finalArenaRadius;
    }
    return CONFIG.arenaRadius;
  }

  /** Cap for current stage — Swiss 1v1 is intentionally faster. */
  _battleMaxSpeed() {
    const base = CONFIG.maxSpeed;
    if (this.finalStage === "swiss") {
      return base * (CONFIG.swissSpeedMult || 1.7);
    }
    return base;
  }

  _isBattlingStage() {
    return (
      this.phase === "main" ||
      this.phase === "invasion" ||
      this.finalStage === "main" ||
      this.finalStage === "invasion" ||
      this.finalStage === "swiss" ||
      this.finalStage === "battle"
    );
  }

  /** Record elimination for ranking — last death wins if they revived earlier. */
  _recordDeath(flag) {
    if (!flag?.code) return;
    this._deathSeq = this._deathSeq.filter((d) => d.code !== flag.code);
    this._deathSeq.push({
      code: flag.code,
      name: flag.name,
      img: flag.img || flagUrl(flag.code, 80),
      at: Date.now(),
    });
  }

  /**
   * Swiss / Final 4: if a bounce left the flag slow, give it a small speed kick.
   */
  _boostSlowBattleBounce(f) {
    if (!this._isBattlingStage() || !f?.alive || f.falling) return;
    const maxSp = this._battleMaxSpeed();
    const minSp = maxSp * (CONFIG.battleMinBounceSpeed ?? 0.78);
    const boost = CONFIG.battleBounceBoost ?? 1.55;
    let speed = Math.hypot(f.vx, f.vy);
    if (speed < 0.04) {
      const dir = rand(0, Math.PI * 2);
      f.vx = Math.cos(dir) * minSp;
      f.vy = Math.sin(dir) * minSp;
      return;
    }
    if (speed >= minSp) return;
    const target = Math.min(maxSp, Math.max(minSp, speed * boost));
    const s = target / speed;
    f.vx *= s;
    f.vy *= s;
  }

  async start() {
    if (this.phase !== "idle" && this.phase !== "finished" && this.phase !== "qualifying_complete")
      return;
    this.reset();
    this.events = [];
    this.phaseStartedAt = performance.now();
    this.qualifyingEndsAt = 0;
    this.streamMode = STREAM_MODE;
    this.testStream = TEST_STREAM;

    if (IS_TEST_STREAM) {
      this._startTestStream(TEST_STREAM);
      this._startLoop();
      this._flushUi(true);
      return;
    }

    // Unified format: Opening → Main (events) → Alien Invasion.
    this.stream = {
      id: newStreamId(),
      mode: "qualifying",
      status: "live",
      startedAt: new Date().toISOString(),
      endedAt: null,
      scheduledAt: null,
      rounds: [],
      final: null,
      qualified: [],
      winner: null,
      sourceStreamId: null,
      format: "opening_main_invasion",
    };
    this._publishLive();
    if (params.get("sprint") === "0" || params.get("opening") === "0") {
      this._startMainArena();
    } else {
      this._startSprint();
    }
    this._startLoop();
    this._flushUi(true);
  }

  /** Easy teststream — synthetic field, short timings, zero persistence.
   * Default (`full`) = Opening → Main → Invasion. */
  _startTestStream(kind) {
    const mode =
      kind === "full" ||
      kind === "qualifying" ||
      kind === "opening" ||
      kind === "sprint" ||
      kind === "main" ||
      kind === "invasion"
        ? "qualifying"
        : "final";
    this.streamMode = mode;
    this.stream = {
      id: `test_${kind}_${Date.now().toString(36)}`,
      mode,
      status: "test",
      startedAt: new Date().toISOString(),
      endedAt: null,
      scheduledAt: null,
      rounds: [],
      final: null,
      qualified: [],
      winner: null,
      sourceStreamId: null,
      testStream: kind,
      format: "opening_main_invasion",
    };
    const label =
      kind === "full"
        ? "Opening → Main → Invasion"
        : kind === "opening"
          ? "opening"
          : kind;
    this._emit("phase", `TESTSTREAM · ${label} (easy · no save)`);
    this._initTeststreamPoll();

    if (kind === "full" || kind === "qualifying") {
      this._publishLive();
      if (params.get("sprint") === "0" || params.get("opening") === "0") {
        this._startMainArena();
      } else {
        this._startSprint();
      }
      return;
    }

    if (kind === "opening" || kind === "sprint") {
      this._publishLive();
      this._startSprint();
      return;
    }

    if (kind === "main") {
      this._publishLive();
      this._startMainArena({ showcaseEvent: "saw" });
      return;
    }

    if (kind === "invasion") {
      this._publishLive();
      this._fillSprintField();
      for (const f of this.fighters) {
        f.hp = CONFIG.baseHp;
        f.maxHp = CONFIG.baseHp;
      }
      this._startInvasion();
      return;
    }

    if (kind === "hole") {
      // Start above Swiss cutoff so the hole stage actually runs.
      this.qualified = this._syntheticField(24);
      this.stream.qualified = this.qualified.map((q) => ({
        code: q.code,
        name: q.name,
        img: q.img,
      }));
      this._publishLive();
      this._beginFinalHole(this.qualified);
      return;
    }

    if (kind === "swiss") {
      this.qualified = this._syntheticField(CONFIG.swissCutoff);
      this.stream.qualified = this.qualified.map((q) => ({
        code: q.code,
        name: q.name,
        img: q.img,
      }));
      this._publishLive();
      this._beginSwissFromHole(
        this.qualified.map((c, i) => this._makeFighter(c, i, this.qualified.length))
      );
      return;
    }

    // final4 — last-flag battling
    this.qualified = this._syntheticField(4);
    this.stream.qualified = this.qualified.map((q) => ({
      code: q.code,
      name: q.name,
      img: q.img,
    }));
    this._swissPool = this.qualified.map((q) => ({ ...q, points: 3 }));
    this._publishLive();
    this._beginFinalBattle(this.qualified.map((q) => ({ ...q, points: 3 })));
  }

  /** Same on-stream poll chrome as a real go-live (memory only). */
  _initTeststreamPoll() {
    if (!this.stream?.id) return;
    initLocalPoll(
      this.stream.id,
      COUNTRIES.map((c) => ({
        code: c.code,
        name: c.name,
        img: flagUrl(c.code, 80),
      }))
    );
    seedTeststreamPollDemo(this.stream.id);
    if (typeof this._stopTeststreamChatDemo === "function") {
      this._stopTeststreamChatDemo();
    }
    // Every Easy teststream: simulate chatters typing bare country names / !vote.
    this._stopTeststreamChatDemo = startTeststreamChatVoteDemo(
      this.stream.id,
      parseVoteMessage
    );
  }

  _syntheticField(n) {
    return shuffle(COUNTRIES)
      .slice(0, Math.min(n, COUNTRIES.length))
      .map((c) => ({
        code: c.code,
        name: c.name,
        img: flagUrl(c.code, 80),
        id: c.code,
        points: 0,
      }));
  }

  /** Reuse the Final stream created when Qualifying ended. */
  async _adoptScheduledFinalStream() {
    if (IS_TEST_STREAM) return;
    let streams = [];
    try {
      await resolveApiBase();
      streams = (await fetchStreamsFromApi()) || [];
    } catch {
      /* ignore */
    }
    if (!streams.length) {
      try {
        const res = await fetch(pagesDataUrl("rankings.json"), {
          cache: "no-store",
        });
        if (res.ok) streams = await res.json();
      } catch {
        /* ignore */
      }
    }
    const list = Array.isArray(streams) ? streams : [];
    const pending = list.find(
      (s) =>
        s?.mode === "final" &&
        !s?.endedAt &&
        (s?.status === "scheduled" || s?.status === "pending") &&
        Array.isArray(s.qualified) &&
        s.qualified.length
    );
    if (!pending) return;

    this.stream = {
      ...pending,
      status: "live",
      startedAt: pending.startedAt || new Date().toISOString(),
      endedAt: null,
      rounds: Array.isArray(pending.rounds) ? pending.rounds : [],
      final: null,
      winner: null,
    };
    this.qualified = pending.qualified.map((q) => ({
      code: q.code,
      name: q.name,
      img: q.img || flagUrl(q.code, 80),
      id: q.code,
      points: Number(q.points) || 0,
    }));
    this.finalLiveAt = pending.scheduledAt || null;
    this._emit(
      "phase",
      `Using scheduled Final stream · ${this.qualified.length} finalists.`
    );
  }

  /** Pull qualifiers from the latest finished qualifying livestream. */
  async _loadQualifiersFromHistory() {
    if (IS_TEST_STREAM) {
      this.qualified = this._syntheticField(24);
      return;
    }
    let streams = [];
    try {
      await resolveApiBase();
      streams = (await fetchStreamsFromApi()) || [];
    } catch {
      /* ignore */
    }
    if (!streams.length) {
      try {
        const res = await fetch(pagesDataUrl("rankings.json"), {
          cache: "no-store",
        });
        if (res.ok) streams = await res.json();
      } catch {
        /* ignore */
      }
    }
    const list = Array.isArray(streams) ? streams : [];
    const prior =
      list.find(
        (s) =>
          s?.mode === "qualifying" &&
          s?.endedAt &&
          Array.isArray(s.qualified) &&
          s.qualified.length
      ) ||
      list.find(
        (s) =>
          s?.endedAt &&
          Array.isArray(s.qualified) &&
          s.qualified.length &&
          !s?.final?.ranking?.length
      ) ||
      list.find((s) => Array.isArray(s.qualified) && s.qualified.length);

    if (prior?.qualified?.length) {
      this.qualified = prior.qualified.map((q) => ({
        code: q.code,
        name: q.name,
        img: q.img || flagUrl(q.code, 80),
        id: q.code,
      }));
      if (this.stream) this.stream.sourceStreamId = prior.id || null;
      this._emit(
        "phase",
        `Loaded ${this.qualified.length} qualifiers from prior stream.`
      );
      return;
    }

    // Fallback — never leave Final empty.
    this.qualified = shuffle(COUNTRIES)
      .slice(0, Math.min(16, COUNTRIES.length))
      .map((c) => ({
        code: c.code,
        name: c.name,
        img: flagUrl(c.code, 80),
        id: c.code,
      }));
    this._emit(
      "phase",
      "No prior qualifiers found — sudden-death field of 16."
    );
  }

  /** Open poll early so chat typing works during Sprint + Qualifying. */
  _ensureOpenPoll() {
    if (!this.stream) return;
    const existing = getLocalPoll(this.stream.id);
    if (existing?.options?.length) return;
    initLocalPoll(
      this.stream.id,
      COUNTRIES.map((c) => ({
        code: c.code,
        name: c.name,
        img: flagUrl(c.code, 80),
      }))
    );
  }

  /**
   * Opening (Sprint-like): all flags, smaller hole.
   * Chat spawn = vote; every 5 votes grows a big flag. Round wins unscored.
   */
  _startSprint() {
    this._ensureOpenPoll();
    this.round = 0;
    this.qualified = [];
    this.eliminated = [];
    this._fallOrder = [];
    this._deathSeq = [];
    this._pendingSprintReset = false;
    this._pendingSprintEnd = false;
    this.recentSprintWins = [];
    this.recentSpawns = [];
    this.arenaEvent = null;
    this.aliens = [];
    this.sprintEndsAt = performance.now() + CONFIG.sprintMs;
    this.phase = "sprint";
    this.finalStage = null;
    this.streamMode = "qualifying";
    this._fillSprintField();
    const mins = Math.max(1, Math.round(CONFIG.sprintMs / 60000));
    this._emit(
      "phase",
      `OPENING — ${mins}:00 · type a country to spawn (= vote) · big flag every ${CONFIG.votesPerBigFlag} votes`
    );
    this._publishLive();
    this._uiDirty = true;
  }

  _fillSprintField() {
    const list = shuffle(COUNTRIES);
    this.fighters = list.map((c, i) => this._makeFighter(c, i, list.length));
    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    this._uiDirty = true;
  }

  /**
   * Chat / poll: spawn or revive a country (Opening + Main + Invasion).
   * Each call counts as a vote/spawn — every 5 grows a big flag.
   * @returns {boolean}
   */
  spawnSprintCountry(code, { voter = "", avatar = "" } = {}) {
    const mainBetween =
      this.phase === "between_rounds" && this._pendingMainReset;
    if (
      this.phase !== "sprint" &&
      this.phase !== "main" &&
      this.phase !== "invasion" &&
      !mainBetween
    ) {
      return false;
    }
    const c = String(code || "").toLowerCase();
    const country = COUNTRIES.find((x) => x.code === c);
    if (!country) return false;

    const entry = {
      code: country.code,
      name: country.name,
      img: flagUrl(country.code, 80),
      voter: String(voter || "").replace(/^@/, "").slice(0, 40),
      avatar: String(avatar || "").slice(0, 500),
      at: Date.now(),
    };
    // Keep every spawn (same flag can appear multiple times on the board).
    this.recentSpawns = [entry, ...this.recentSpawns].slice(0, 12);

    let f = this.fighters.find((x) => x.code === country.code);
    const prevVotes = Number(f?.spawnVotes) || 0;
    const nextVotes = prevVotes + 1;
    const grew =
      Math.floor(nextVotes / CONFIG.votesPerBigFlag) >
      Math.floor(prevVotes / CONFIG.votesPerBigFlag);

    if (f && f.alive && !f.falling) {
      f.spawnVotes = nextVotes;
      f.sizeMult = this._sizeMultForVotes(nextVotes);
      f.pulse = 1;
      if (entry.voter) f.spawnedBy = entry.voter;
      if (grew) {
        playSfx("bigflag");
        this._emit(
          "phase",
          `${country.name} grew BIG (${nextVotes} votes)!`
        );
      } else {
        playSfx("spawn");
      }
      this._uiDirty = true;
      return true;
    }

    if (f) {
      // Revive — clear prior death ranking until they die again.
      f.alive = true;
      f.falling = false;
      f.hp = f.maxHp || CONFIG.baseHp;
      f.spawnVotes = nextVotes;
      f.sizeMult = this._sizeMultForVotes(nextVotes);
      const ang = rand(0, Math.PI * 2);
      const rad = rand(0.08, this.arenaRadiusNow() * 0.55);
      f.x = 0.5 + Math.cos(ang) * rad;
      f.y = 0.5 + Math.sin(ang) * rad;
      f.vx = rand(-0.35, 0.35);
      f.vy = rand(-0.35, 0.35);
      f.pulse = 1;
      if (entry.voter) f.spawnedBy = entry.voter;
    } else {
      f = this._makeFighter(
        { ...country, spawnVotes: nextVotes },
        this.fighters.length,
        this.fighters.length + 1
      );
      f.pulse = 1;
      if (entry.voter) f.spawnedBy = entry.voter;
      this.fighters.push(f);
    }
    playSfx(grew ? "bigflag" : "spawn");
    this._emit(
      "phase",
      `${entry.voter || "Chat"} spawned ${country.name}${grew ? " · BIG!" : ""} (${nextVotes} votes)`
    );
    this._uiDirty = true;
    return true;
  }

  _sprintWin(flag) {
    if (!flag?.code || this._pendingSprintReset || this._pendingSprintEnd) return;
    const win = {
      code: flag.code,
      name: flag.name,
      img: flag.img || flagUrl(flag.code, 80),
      at: Date.now(),
    };
    this.recentSprintWins = [win, ...this.recentSprintWins].slice(0, 16);
    flag.pulse = 1;
    playSfx("opening_win");
    this.phase = "between_rounds";
    this._pendingSprintReset = true;
    this._betweenUntil =
      performance.now() + Math.max(900, CONFIG.betweenRoundMs);
    this._emit(
      "phase",
      `SPRINT WIN — ${flag.name}! (no season points) · resetting…`
    );
    this._publishLive();
    this._uiDirty = true;
  }

  _resetSprintRound() {
    this._pendingSprintReset = false;
    if (this.sprintEndsAt && performance.now() >= this.sprintEndsAt) {
      this._endSprint();
      return;
    }
    this.phase = "sprint";
    this.round += 1;
    this.eliminated = [];
    this._fallOrder = [];
    this._fillSprintField();
    this._emit(
      "phase",
      `SPRINT round ${this.round + 1} — type a country to spawn · smaller hole`
    );
    this._publishLive();
  }

  _endSprint() {
    this._pendingSprintReset = false;
    this._pendingSprintEnd = false;
    this.sprintEndsAt = 0;
    this._emit(
      "phase",
      `Opening over — ${this.recentSprintWins.length} spawn-round win${this.recentSprintWins.length === 1 ? "" : "s"} (unscored). Main arena next.`
    );
    this._startMainArena();
  }

  /**
   * Main arena: all countries, HP bars, attacking, random 30s events.
   * Last standing earns a point and the round resets; the ~50 min clock
   * only starts Alien Invasion (endgame). Points rank the final board.
   * @param {{ showcaseEvent?: ArenaEventType }} [opts]
   */
  _startMainArena(opts = {}) {
    this._ensureOpenPoll();
    document.body.classList.add("final-mode");
    document.body.classList.remove("invasion-mode");
    this.phase = "main";
    this.finalStage = "main";
    this.streamMode = "final";
    this.arenaEvent = null;
    this.aliens = [];
    this.eliminated = [];
    this._deathSeq = [];
    this._pendingMainReset = false;
    this.mainRoundPoints = new Map();
    this.mainPointAt = new Map();
    this.recentMainWins = [];
    const span =
      CONFIG.mainMsMin +
      Math.random() * Math.max(0, CONFIG.mainMsMax - CONFIG.mainMsMin);
    this.mainEndsAt = performance.now() + span;
    this.nextEventAt =
      performance.now() +
      (opts.showcaseEvent
        ? 800
        : rand(CONFIG.eventGapMinMs, CONFIG.eventGapMaxMs));

    // Carry spawn votes / revive field — refill if empty.
    if (!this.fighters.length) this._fillSprintField();
    for (const f of this.fighters) {
      f.alive = true;
      f.falling = false;
      f.hp = CONFIG.baseHp;
      f.maxHp = CONFIG.baseHp;
      f.spawnVotes = Number(f.spawnVotes) || 0;
      f.sizeMult = this._sizeMultForVotes(f.spawnVotes);
    }
    // Seed a few big flags so the mode reads clearly on stream / screenshots.
    const seeds = shuffle(this.fighters).slice(0, 6);
    for (const f of seeds) {
      f.spawnVotes = Math.max(f.spawnVotes, CONFIG.votesPerBigFlag * (1 + ((Math.random() * 2) | 0)));
      f.sizeMult = this._sizeMultForVotes(f.spawnVotes);
    }

    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    if (this.stream) {
      this.stream.mode = "final";
      this.stream.mainRoundPoints = {};
      this.stream.mainPointAt = {};
      this.stream.recentMainWins = [];
    }
    const mins = Math.max(1, Math.round(span / 60000));
    this._emit(
      "phase",
      `MAIN — last standing = +1 point · ~${mins} min → Alien Invasion · events live`
    );
    if (opts.showcaseEvent) {
      // Showcase: keep a full field + visible event (no instant wipe).
      this._showcaseMain = true;
      this._beginArenaEvent(opts.showcaseEvent);
    } else {
      this._showcaseMain = false;
    }
    this._publishLive();
    this._uiDirty = true;
  }

  /**
   * Main round win: +1 point for last standing, then reset the field.
   * Does NOT end the stream — the Main clock still leads to Invasion.
   */
  _mainWin(flag) {
    if (
      !flag?.code ||
      this._pendingMainReset ||
      this._showcaseMain ||
      this.phase !== "main"
    ) {
      return;
    }
    const code = flag.code;
    const next = (this.mainRoundPoints.get(code) || 0) + 1;
    this.mainRoundPoints.set(code, next);
    if (!this.mainPointAt.has(code)) this.mainPointAt.set(code, Date.now());

    const win = {
      code: flag.code,
      name: flag.name,
      img: flag.img || flagUrl(flag.code, 80),
      at: Date.now(),
      points: next,
    };
    this.recentMainWins = [win, ...this.recentMainWins].slice(0, 16);
    flag.pulse = 1;
    playSfx("opening_win");
    this.phase = "between_rounds";
    this._pendingMainReset = true;
    this._betweenUntil =
      performance.now() + Math.max(900, CONFIG.betweenRoundMs);
    this._emit(
      "phase",
      `MAIN POINT — ${flag.name}! (${next} pt${next === 1 ? "" : "s"}) · resetting…`
    );
    this._persistMainPoints();
    this._publishLive();
    this._uiDirty = true;
  }

  _persistMainPoints() {
    if (!this.stream) return;
    const points = {};
    for (const [code, n] of this.mainRoundPoints) points[code] = n;
    const firstAt = {};
    for (const [code, at] of this.mainPointAt) {
      firstAt[code] = new Date(at).toISOString();
    }
    this.stream.mainRoundPoints = points;
    this.stream.mainPointAt = firstAt;
    this.stream.recentMainWins = (this.recentMainWins || []).slice(0, 16);
    saveStream(this.stream);
  }

  /** Refill Main after a point round, or start Invasion if the clock expired. */
  _resetMainRound() {
    this._pendingMainReset = false;
    if (this.mainEndsAt && performance.now() >= this.mainEndsAt) {
      this._emit("phase", "Main time’s up — ALIEN INVASION!");
      this._startInvasion();
      return;
    }

    // Keep chat vote sizes across Main round resets.
    const voteMap = new Map(
      this.fighters.map((f) => [
        f.code,
        {
          spawnVotes: Number(f.spawnVotes) || 0,
          sizeMult: Number(f.sizeMult) || 1,
        },
      ])
    );

    this.phase = "main";
    this.finalStage = "main";
    this.round += 1;
    this.eliminated = [];
    this._fallOrder = [];
    this._deathSeq = [];
    this.arenaEvent = null;
    this._fillSprintField();
    for (const f of this.fighters) {
      const prev = voteMap.get(f.code);
      if (prev) {
        f.spawnVotes = prev.spawnVotes;
        f.sizeMult = this._sizeMultForVotes(prev.spawnVotes);
      }
      f.hp = CONFIG.baseHp;
      f.maxHp = CONFIG.baseHp;
      f.alive = true;
      f.falling = false;
    }
    this._scheduleNextEvent();
    const leaders = this._mainPointLeaders(3)
      .map((r) => `${r.name} ${r.points}`)
      .join(" · ");
    this._emit(
      "phase",
      `MAIN round ${this.round + 1} — last standing = +1 point${
        leaders ? ` · lead: ${leaders}` : ""
      }`
    );
    this._publishLive();
    this._uiDirty = true;
  }

  /** Sorted Main point leaders for board / HUD. */
  _mainPointLeaders(limit = 24) {
    const rows = [];
    for (const [code, points] of this.mainRoundPoints) {
      if (!points) continue;
      const known =
        this.fighters.find((f) => f.code === code) ||
        COUNTRIES.find((c) => c.code === code);
      rows.push({
        code,
        name: known?.name || code.toUpperCase(),
        img: known?.img || flagUrl(code, 80),
        points,
        firstAt: this.mainPointAt.get(code) || 0,
      });
    }
    rows.sort(
      (a, b) =>
        b.points - a.points ||
        (a.firstAt || 0) - (b.firstAt || 0) ||
        a.name.localeCompare(b.name)
    );
    return limit ? rows.slice(0, limit) : rows;
  }

  _scheduleNextEvent(now = performance.now()) {
    this.nextEventAt =
      now + rand(CONFIG.eventGapMinMs, CONFIG.eventGapMaxMs);
  }

  _beginArenaEvent(type) {
    const kinds = ["saw", "blackhole", "catch"];
    const pick =
      type && kinds.includes(type)
        ? type
        : kinds[(Math.random() * kinds.length) | 0];
    const endsAt = performance.now() + CONFIG.eventDurationMs;
    /** @type {{ type: ArenaEventType, endsAt: number, angle?: number, hunterCode?: string, label?: string }} */
    const ev = { type: pick, endsAt, angle: rand(0, Math.PI * 2) };
    if (pick === "catch") {
      const pool = this.fighters.filter((f) => f.alive && !f.falling);
      const hunter = pool[(Math.random() * pool.length) | 0];
      if (hunter) {
        ev.hunterCode = hunter.code;
        hunter.pulse = 1;
        hunter.sizeMult = Math.max(hunter.sizeMult || 1, 1.7);
      }
      ev.label = hunter ? `${hunter.name} is the CATCHER` : "CATCH";
    } else if (pick === "saw") {
      ev.label = "CIRCULAR SAW";
      const ang = rand(0, Math.PI * 2);
      const rad = rand(0.1, this.arenaRadiusNow() * 0.55);
      ev.x = 0.5 + Math.cos(ang) * rad;
      ev.y = 0.5 + Math.sin(ang) * rad;
      ev.vx = rand(-0.4, 0.4);
      ev.vy = rand(-0.4, 0.4);
      ev.spin = 0;
    } else {
      ev.label = "BLACK HOLE";
    }
    this.arenaEvent = ev;
    playSfx("event");
    // Event-specific stinger (saw buzz / black-hole whoosh / catch snap).
    if (pick === "saw" || pick === "blackhole" || pick === "catch") {
      playSfx(pick);
    }
    this._emit("phase", `EVENT — ${ev.label} · 30s`);
    this._uiDirty = true;
  }

  _clearArenaEvent() {
    if (this.arenaEvent?.type === "catch" && this.arenaEvent.hunterCode) {
      const h = this.fighters.find((f) => f.code === this.arenaEvent.hunterCode);
      if (h) h.sizeMult = this._sizeMultForVotes(h.spawnVotes || 0);
    }
    this.arenaEvent = null;
    this._scheduleNextEvent();
    this._uiDirty = true;
  }

  _tickArenaEvents(dt, now) {
    if (this.phase !== "main") return;
    if (this.arenaEvent) {
      if (now >= this.arenaEvent.endsAt) {
        this._emit("phase", `Event over — next soon`);
        this._clearArenaEvent();
      } else {
        this._applyActiveEvent(dt);
      }
      return;
    }
    if (this.nextEventAt && now >= this.nextEventAt) {
      this._beginArenaEvent();
    }
  }

  _applyActiveEvent(dt) {
    const ev = this.arenaEvent;
    if (!ev) return;
    if (ev.type === "saw") {
      // Small circular saw that drifts inside the arena.
      ev.spin = (ev.spin || 0) + 8 * dt;
      ev.x = (ev.x ?? 0.5) + (ev.vx || 0) * dt;
      ev.y = (ev.y ?? 0.5) + (ev.vy || 0) * dt;
      const R = this.arenaRadiusNow() * this.arenaScale;
      const sawR = CONFIG.sawRadius ?? 0.055;
      const distC = Math.hypot(ev.x - 0.5, ev.y - 0.5);
      const limit = R - sawR - 0.01;
      if (distC > limit) {
        const nx = (ev.x - 0.5) / (distC || 1);
        const ny = (ev.y - 0.5) / (distC || 1);
        ev.x = 0.5 + nx * limit;
        ev.y = 0.5 + ny * limit;
        const vn = (ev.vx || 0) * nx + (ev.vy || 0) * ny;
        if (vn > 0) {
          ev.vx = (ev.vx || 0) - 1.8 * vn * nx;
          ev.vy = (ev.vy || 0) - 1.8 * vn * ny;
        }
      }
      for (const f of this.fighters) {
        if (!f.alive || f.falling) continue;
        const hitR = sawR + this._flagRadiusFor(f) * 0.85;
        if (Math.hypot(f.x - ev.x, f.y - ev.y) < hitR) {
          this._eventEliminate(f, "saw", "saw");
        }
      }
    } else if (ev.type === "blackhole") {
      for (const f of this.fighters) {
        if (!f.alive || f.falling) continue;
        const dx = 0.5 - f.x;
        const dy = 0.5 - f.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        f.vx += (dx / dist) * 1.1 * dt;
        f.vy += (dy / dist) * 1.1 * dt;
        if (dist < 0.045) this._eventEliminate(f, "black hole", "blackhole");
      }
    } else if (ev.type === "catch" && ev.hunterCode) {
      const hunter = this.fighters.find(
        (f) => f.code === ev.hunterCode && f.alive && !f.falling
      );
      if (!hunter) return;
      const hr = this._flagRadiusFor(hunter);
      for (const f of this.fighters) {
        if (f === hunter || !f.alive || f.falling) continue;
        const minD = hr + this._flagRadiusFor(f);
        if (Math.hypot(f.x - hunter.x, f.y - hunter.y) < minD * 0.95) {
          this._eventEliminate(f, hunter.name, "catch");
        }
      }
    }
  }

  _eventEliminate(f, byLabel, sfxKind = "elim") {
    if (!f?.alive || f.falling) return;
    // Showcase / keep Main readable — events deal heavy damage, not always wipe.
    if (this._showcaseMain) {
      f.hp = Math.max(1, (f.hp || CONFIG.baseHp) - 35);
      f.pulse = 1;
      playSfx(sfxKind || "hit");
      this._uiDirty = true;
      return;
    }
    f.alive = false;
    f.hp = 0;
    this._recordDeath(f);
    this.eliminated.push(f);
    playSfx(sfxKind || "elim");
    this._emit("elim", `${f.name} eliminated by ${byLabel}`);
    this._uiDirty = true;
  }

  /** Alien invasion endgame — hole closed, aliens attack, last alive wins. */
  _startInvasion() {
    this._ensureOpenPoll();
    document.body.classList.add("final-mode", "invasion-mode");
    this.phase = "invasion";
    this.finalStage = "invasion";
    this.streamMode = "final";
    this.arenaEvent = null;
    this.mainEndsAt = 0;
    this._pendingMainReset = false;
    this._deathSeq = [];
    this._persistMainPoints();
    if (!this.fighters.length) this._fillSprintField();
    for (const f of this.fighters) {
      if (!f.alive) {
        // Keep dead out — invasion is last stand of current survivors.
        continue;
      }
      f.falling = false;
      f.hp = Math.max(25, f.hp || CONFIG.baseHp);
      f.maxHp = CONFIG.baseHp;
    }
    // If somehow nobody alive, revive a pack.
    if (!this.fighters.some((f) => f.alive)) {
      for (const f of shuffle(this.fighters).slice(0, 40)) {
        f.alive = true;
        f.falling = false;
        f.hp = CONFIG.baseHp;
      }
    }
    const n = CONFIG.alienCount || 5;
    this.aliens = Array.from({ length: n }, () => {
      const ang = rand(0, Math.PI * 2);
      const rad = rand(0.15, this.arenaRadiusNow() * 0.75);
      return {
        x: 0.5 + Math.cos(ang) * rad,
        y: 0.5 + Math.sin(ang) * rad,
        vx: rand(-0.55, 0.55),
        vy: rand(-0.55, 0.55),
      };
    });
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    if (this.stream) this.stream.mode = "final";
    playSfx("invasion");
    this._emit(
      "phase",
      "ALIEN INVASION — hole sealed · survive the attack · last flag standing wins"
    );
    this._publishLive();
    this._uiDirty = true;
  }

  _tickAliens(dt) {
    const R = this.arenaRadiusNow() * this.arenaScale;
    const dps = CONFIG.alienDps || 18;
    for (const a of this.aliens) {
      // Chase nearest living flag.
      let best = null;
      let bestD = Infinity;
      for (const f of this.fighters) {
        if (!f.alive || f.falling) continue;
        const d = Math.hypot(f.x - a.x, f.y - a.y);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best) {
        const dx = best.x - a.x;
        const dy = best.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        a.vx += (dx / len) * 1.4 * dt;
        a.vy += (dy / len) * 1.4 * dt;
      }
      const sp = Math.hypot(a.vx, a.vy);
      const maxSp = 0.85;
      if (sp > maxSp) {
        a.vx = (a.vx / sp) * maxSp;
        a.vy = (a.vy / sp) * maxSp;
      }
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      const dist = Math.hypot(a.x - 0.5, a.y - 0.5);
      if (dist > R - 0.02) {
        const nx = (a.x - 0.5) / (dist || 1);
        const ny = (a.y - 0.5) / (dist || 1);
        a.x = 0.5 + nx * (R - 0.02);
        a.y = 0.5 + ny * (R - 0.02);
        a.vx *= -0.6;
        a.vy *= -0.6;
      }
      for (const f of this.fighters) {
        if (!f.alive || f.falling) continue;
        if (Math.hypot(f.x - a.x, f.y - a.y) < 0.05) {
          f.hp = Math.max(0, (f.hp || 0) - dps * dt);
          f.pulse = 1;
          if (f.hp <= 0) {
            f.alive = false;
            this._recordDeath(f);
            this.eliminated.push(f);
            playSfx("alien");
            this._emit("elim", `${f.name} eliminated by alien`);
          } else {
            playSfx("alien");
          }
          this._uiDirty = true;
        }
      }
    }
  }

  /**
   * Open the winner poll and start Qualifying immediately (no intermission).
   */
  _startOpenBattle() {
    this.round = 0;
    this._ensureOpenPoll();
    this.qualifyingEndsAt = performance.now() + CONFIG.qualifyingMs;
    const qSec = Math.max(1, Math.round(CONFIG.qualifyingMs / 1000));
    const qLabel =
      qSec >= 60
        ? `${String(Math.floor(qSec / 60)).padStart(2, "0")}:${String(qSec % 60).padStart(2, "0")}`
        : `0:${String(qSec).padStart(2, "0")}`;
    this._emit(
      "phase",
      `QUALIFYING — ${qLabel} on the clock. All non-qualified countries each round. Poll open (type a country or !vote).`
    );
    this._startNextQualifyingRound();
    this._publishLive();
  }

  /** Ensure a Final poll exists (carry Qual votes, or open a fresh one). */
  _ensureBattlePoll() {
    if (!this.stream) return;
    const existing = getLocalPoll(this.stream.id);
    if (existing?.options?.length) return;
    const fromSource = this.stream.sourceStreamId
      ? transferPoll(this.stream.sourceStreamId, this.stream.id)
      : null;
    if (fromSource?.options?.length) return;
    initLocalPoll(
      this.stream.id,
      COUNTRIES.map((c) => ({
        code: c.code,
        name: c.name,
        img: flagUrl(c.code, 80),
      }))
    );
  }

  _remainingCountries() {
    return COUNTRIES.filter(
      (c) => !this.qualified.some((q) => q.code === c.code)
    );
  }

  _beginRound(countries) {
    this.round += 1;
    const list = shuffle(countries);
    this.fighters = list.map((c, i) => this._makeFighter(c, i, list.length));
    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    this._fallOrder = [];
    this.phase = "qualifying";
    this._uiDirty = true;
    this._emit(
      "phase",
      `Round ${this.round} — ${list.length} flags in. Last one qualifies!`
    );
    this._publishLive();
  }

  stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._lastTs = 0;
  }

  _startLoop() {
    this.stopLoop();
    const tick = (ts) => {
      if (!this._lastTs) this._lastTs = ts;
      const dt = Math.min(0.05, (ts - this._lastTs) / 1000);
      this._lastTs = ts;
      this.update(dt, ts);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  update(dt, now) {
    // Final champion on screen — hold before marking the stream ended.
    if (
      this.phase === "finished" &&
      this.winner &&
      this._winnerHoldUntil &&
      !this._winnerHoldDone
    ) {
      // Clear the 3s rank-reveal overlay once its pause window ends.
      if (this.rankReveal && this._winRevealUntil && now >= this._winRevealUntil) {
        this.rankReveal = null;
        this._winRevealUntil = 0;
        this._uiDirty = true;
      }
      if (now >= this._winnerHoldUntil) {
        this._completeWinnerHold();
      } else {
        if (!this._lastHoldPub || now - this._lastHoldPub > 2000) {
          this._lastHoldPub = now;
          this._publishLive();
        }
        this.onFrame();
        this._flushUi(true);
      }
      return;
    }

    if (this.phase === "qualifying_hold") {
      if (
        !this.qualifyingExpired &&
        this.qualifyingEndsAt &&
        now >= this.qualifyingEndsAt
      ) {
        this.qualifyingExpired = true;
        this._emit("phase", "Qualifying time complete.");
        this._finishQualifyingStream();
      }
      this.onFrame();
      this._flushUi();
      return;
    }

    if (this.phase === "between_rounds") {
      if (now >= this._betweenUntil) {
        if (this._pendingSprintReset) {
          this._resetSprintRound();
        } else if (this._pendingSprintEnd) {
          this._endSprint();
        } else if (this._pendingMainReset) {
          this._resetMainRound();
        } else if (this._pendingQualComplete) {
          this._pendingQualComplete = false;
          this._finishQualifyingStream();
        } else if (this._pendingFinalReset) {
          this._pendingFinalReset = false;
          const remaining = this._finalResetRemaining || [];
          this._finalResetRemaining = null;
          this._resetFinalHoleRound(remaining);
        } else if (this._pendingSwissPair) {
          this._pendingSwissPair = false;
          this._startNextSwissPair();
        } else if (this._pendingSwissNext) {
          this._pendingSwissNext = false;
          this._beginSwissRound();
        } else if (this._pendingSwissCut) {
          this._pendingSwissCut = false;
          this._cutSwissAndBeginBattle();
        } else {
          this._startNextQualifyingRound();
        }
      }
      this.onFrame();
      this._flushUi();
      return;
    }

    // Sprint clock — end even mid-round (finish current between_rounds first).
    if (
      this.phase === "sprint" &&
      this.sprintEndsAt &&
      now >= this.sprintEndsAt
    ) {
      this.phase = "between_rounds";
      this._pendingSprintEnd = true;
      this._betweenUntil = now + Math.max(600, CONFIG.betweenRoundMs * 0.5);
      this._emit("phase", "Opening time’s up — Main arena next…");
      this.onFrame();
      this._flushUi();
      return;
    }

    // Main clock → Alien Invasion (endgame). Not a win condition.
    if (
      this.mainEndsAt &&
      now >= this.mainEndsAt &&
      (this.phase === "main" ||
        (this.phase === "between_rounds" && this._pendingMainReset))
    ) {
      this._pendingMainReset = false;
      this._emit("phase", "Main time’s up — ALIEN INVASION!");
      this._startInvasion();
      this.onFrame();
      this._flushUi(true);
      return;
    }

    if (this.phase === "qualifying_complete") {
      if (
        this._pendingUnifiedFinal &&
        this._betweenUntil &&
        now >= this._betweenUntil
      ) {
        this._pendingUnifiedFinal = false;
        this._betweenUntil = 0;
        this.streamMode = "final";
        if (this.stream) {
          this.stream.mode = "final";
          this.stream.status = "live";
          saveStream(this.stream);
        }
        document.body.classList.add("final-mode");
        this._ensureBattlePoll();
        this._beginFinal();
        this._flushUi(true);
        return;
      }
      this.onFrame();
      this._flushUi();
      return;
    }

    if (
      this.phase === "sprint" ||
      this.phase === "main" ||
      this.phase === "invasion" ||
      this.phase === "qualifying" ||
      this.phase === "final"
    ) {
      if (
        this.phase === "qualifying" &&
        !this.qualifyingExpired &&
        this.qualifyingEndsAt &&
        now >= this.qualifyingEndsAt
      ) {
        this.qualifyingExpired = true;
        this._emit("phase", "Qualifying clock hit 0 — finishing this round…");
        this._uiDirty = true;
      }

      const battling =
        this.phase === "main" ||
        this.phase === "invasion" ||
        (this.phase === "final" &&
          (this.finalStage === "swiss" || this.finalStage === "battle"));

      if (this.phase === "main" || this.phase === "invasion") {
        // HP combat + solid rim; hole open in main, sealed in invasion.
        this._moveFighters(dt, { physicsRim: true, solidRim: true });
        this._resolveCollisions({ dealHits: true });
        if (this.phase === "main") {
          const elapsed = (now - this.roundStartedAt) / 1000;
          const t = Math.min(1, elapsed / CONFIG.shrinkDurationSec);
          this.arenaScale = 1 - (1 - CONFIG.shrinkMinScale) * (t * t) * 0.35;
          this.holeAngle = normAngle(
            this.holeAngle + CONFIG.holeSpeed * 0.65 * dt
          );
          // Showcase keeps solid rim only so the event reads clearly on stream.
          if (!this._showcaseMain) this._applyCircleAndHole(t);
          this._tickArenaEvents(dt, now);
        } else {
          this.arenaScale = 1;
          this._tickAliens(dt);
        }
        const standingNow = this.fighters.filter((f) => f.alive && !f.falling);
        if (this.phase === "invasion" && standingNow.length <= 1) {
          // Invasion endgame: last standing is the stream champion.
          if (standingNow.length === 1) {
            this._onLastFlag(standingNow[0]);
          } else {
            const last = this._deathSeq[this._deathSeq.length - 1];
            if (last) {
              const f = this.fighters.find((x) => x.code === last.code);
              if (f) {
                f.alive = true;
                f.hp = 1;
                this._onLastFlag(f);
              }
            }
          }
        } else if (
          this.phase === "main" &&
          !this._showcaseMain &&
          standingNow.length <= 1
        ) {
          // Main: last standing earns a point; clock still runs to Invasion.
          if (standingNow.length === 1) {
            this._mainWin(standingNow[0]);
          } else {
            const last = this._deathSeq[this._deathSeq.length - 1];
            if (last) {
              const f = this.fighters.find((x) => x.code === last.code);
              if (f) this._mainWin(f);
            }
          }
        }
      } else if (battling) {
        this._moveFighters(dt, { physicsRim: true, solidRim: true });
        this._resolveCollisions({ dealHits: true });
        this._checkBattleStage();
      } else {
        const elapsed = (now - this.roundStartedAt) / 1000;
        const t = Math.min(1, elapsed / CONFIG.shrinkDurationSec);
        this.arenaScale = 1 - (1 - CONFIG.shrinkMinScale) * (t * t);

        const standing = this.fighters.filter((f) => f.alive && !f.falling);
        const packBoost = 1 + Math.min(1.4, standing.length / 100);
        const lateBoost = 1 + t * 1.1;
        this.holeAngle = normAngle(
          this.holeAngle + CONFIG.holeSpeed * packBoost * lateBoost * dt
        );

        this._moveFighters(dt, { physicsRim: true });
        this._resolveCollisions();
        this._applyCircleAndHole(t);

        const standingNow = this.fighters.filter((f) => f.alive && !f.falling);
        const alive = this.fighters.filter((f) => f.alive);

        if (this.phase === "sprint") {
          if (standingNow.length === 1) {
            for (const f of this.fighters) {
              if (f.falling && f.alive) this._markFallen(f);
            }
            this._sprintWin(standingNow[0]);
          } else if (alive.length === 0) {
            this._emit("phase", "Everyone fell — resetting Sprint field.");
            this.phase = "between_rounds";
            this._pendingSprintReset = true;
            this._betweenUntil =
              now + Math.max(700, CONFIG.betweenRoundMs * 0.6);
          }
        } else if (this.phase === "qualifying") {
          if (standingNow.length === 1) {
            for (const f of this.fighters) {
              if (f.falling && f.alive) this._markFallen(f);
            }
            this._onLastFlag(standingNow[0]);
          } else if (alive.length === 0) {
            this._emit("phase", "Everyone fell — restarting round.");
            this._startNextQualifyingRound();
          }
        } else if (
          this.phase === "final" &&
          this.finalStage === "hole" &&
          alive.length === 0 &&
          !this._finalElimLock
        ) {
          const remaining = this._finalRemainingFromFall();
          if (remaining.length <= CONFIG.swissCutoff && remaining.length > 0) {
            this._beginSwissFromHole(
              remaining.map((c, i) => this._makeFighter(c, i, remaining.length))
            );
          } else if (remaining.length === 0) {
            this._emit("phase", "Everyone fell — restarting Final hole stage.");
            this._beginFinalHole(this.qualified);
          } else {
            this._resetFinalHoleRound(remaining);
          }
        }
      }
    }

    this.onFrame();
    this._flushUi();
  }

  _flushUi(force = false) {
    const now = performance.now();
    if (force || this._uiDirty || now - this._lastUi >= CONFIG.uiThrottleMs) {
      this._lastUi = now;
      this._uiDirty = false;
      this.onChange();
    }
  }

  _flagRadius() {
    const n =
      this.fighters.filter((f) => f.alive && !f.falling).length ||
      this.fighters.length ||
      1;
    return flagSizeForCount(n).radius;
  }

  _flagRadiusFor(f) {
    const base = this._flagRadius();
    const mult = Number(f?.sizeMult) || 1;
    return base * Math.max(0.85, Math.min(CONFIG.bigFlagScaleMax || 2.6, mult));
  }

  _moveFighters(dt, { physicsRim, solidRim = false }) {
    const battling = this._isBattlingStage();
    const outward = physicsRim
      ? battling
        ? CONFIG.battleOutwardForce ?? 0.1
        : CONFIG.outwardForce
      : 0.03;
    const gravity = battling ? CONFIG.battleGravity ?? 0.85 : 0;
    const R = this.arenaRadiusNow() * this.arenaScale;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      if (f.falling) {
        const dx = f.x - 0.5;
        const dy = f.y - 0.5;
        const len = Math.hypot(dx, dy) || 1;
        f.vx += (dx / len) * 1.4 * dt;
        f.vy += (dy / len) * 1.4 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (Math.hypot(f.x - 0.5, f.y - 0.5) > 0.8) this._markFallen(f);
        continue;
      }

      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const len = Math.hypot(dx, dy) || 1;
      f.vx += (dx / len) * outward * dt;
      f.vy += (dy / len) * outward * dt;
      // Swiss / Final 4: constant pull toward the bottom of the arena.
      if (gravity) f.vy += gravity * dt;

      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.pulse > 0) f.pulse = Math.max(0, f.pulse - dt * 4);
      if (f.hitCd > 0) f.hitCd = Math.max(0, f.hitCd - dt);

      if (solidRim) {
        const fr = this._flagRadiusFor(f);
        const dist = Math.hypot(f.x - 0.5, f.y - 0.5);
        const limit = R - fr;
        if (dist > limit) {
          const nx = (f.x - 0.5) / (dist || 1);
          const ny = (f.y - 0.5) / (dist || 1);
          f.x = 0.5 + nx * limit;
          f.y = 0.5 + ny * limit;
          const vn = f.vx * nx + f.vy * ny;
          if (vn > 0) {
            f.vx -= 2.0 * vn * nx;
            f.vy -= 2.0 * vn * ny;
            this._boostSlowBattleBounce(f);
          }
        }
      }

      const speed = Math.hypot(f.vx, f.vy);
      const maxSp = this._battleMaxSpeed();
      if (speed > maxSp) {
        f.vx = (f.vx / speed) * maxSp;
        f.vy = (f.vy / speed) * maxSp;
      } else if (speed < 0.2) {
        const dir = rand(0, Math.PI * 2);
        f.vx += Math.cos(dir) * 0.15;
        f.vy += Math.sin(dir) * 0.15;
      }
    }
  }

  _resolveCollisions({ dealHits = false } = {}) {
    const active = [];
    for (const f of this.fighters) {
      if (f.alive && !f.falling) active.push(f);
    }
    const n = active.length;
    if (n < 2) return;

    const baseR = this._flagRadius();
    const cell = Math.max(baseR * 2.05, 0.04);
    const inv = 1 / cell;
    if (!this._colGrid) this._colGrid = new Map();
    const grid = this._colGrid;
    grid.clear();

    for (let i = 0; i < n; i++) {
      const f = active[i];
      f._r = this._flagRadiusFor(f);
      const cx = (f.x * inv) | 0;
      const cy = (f.y * inv) | 0;
      f._cx = cx;
      f._cy = cy;
      const k = ((cx + 4096) << 13) | ((cy + 4096) & 0x1fff);
      let bucket = grid.get(k);
      if (!bucket) {
        bucket = [];
        grid.set(k, bucket);
      }
      bucket.push(i);
    }

    for (let i = 0; i < n; i++) {
      const a = active[i];
      const cx = a._cx;
      const cy = a._cy;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const other = grid.get(
            ((cx + ox + 4096) << 13) | ((cy + oy + 4096) & 0x1fff)
          );
          if (!other) continue;
          for (let b = 0; b < other.length; b++) {
            const j = other[b];
            if (j <= i) continue;
            const A = a;
            const B = active[j];
            const dx = B.x - A.x;
            const dy = B.y - A.y;
            const distSq = dx * dx + dy * dy;
            const minDist = (A._r + B._r) * 1.02;
            const minSq = minDist * minDist;
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

            if (dealHits) {
              // nx points A → B. Approach speed > 0 when they slam together.
              // closing = how fast the gap shrinks = avn - bvn.
              const approach = avn - bvn;
              const minHit = CONFIG.hitSpeedMin ?? 0.22;
              if (approach > minHit) {
                // Relative impact: each flag that is driving into the other
                // deals a hit (−hitDamage HP). Head-on slams hit both.
                const aIntoB = avn > minHit * 0.5;
                const bIntoA = -bvn > minHit * 0.5;
                if (aIntoB) this._applyHit(B, A);
                if (bIntoA) this._applyHit(A, B);
                // Mutual scrape/slam with clear closing but unclear aggressor.
                if (!aIntoB && !bIntoA) {
                  this._applyHit(A, B);
                  this._applyHit(B, A);
                }
              }
            }

            const exchange = (avn - bvn) * CONFIG.pushStrength;
            A.vx -= exchange * nx;
            A.vy -= exchange * ny;
            B.vx += exchange * nx;
            B.vy += exchange * ny;
            if (dealHits) {
              this._boostSlowBattleBounce(A);
              this._boostSlowBattleBounce(B);
            }
          }
        }
      }
    }
  }

  /**
   * Apply one collision hit: −hitDamage HP (default 5 of 100).
   * @param {object} f flag taking damage
   * @param {object|null} by flag that dealt the hit
   */
  _applyHit(f, by = null) {
    if (!f?.alive || f.falling) return;
    if ((f.hitCd || 0) > 0) return;
    f.hitCd = CONFIG.hitCooldownSec;
    const dmg = Math.max(1, Number(CONFIG.hitDamage) || 5);
    const maxHp = f.maxHp || CONFIG.baseHp || 100;
    f.hp = Math.max(0, (f.hp ?? maxHp) - dmg);
    f.pulse = 1;
    playSfx(f.hp <= 0 ? "elim" : "hit");
    this._uiDirty = true;
    if (f.hp <= 0) {
      const foe =
        by && by.alive && !by.falling
          ? by
          : this.fighters.find((o) => o !== f && o.alive && !o.falling);
      this._battleEliminate(f, foe || null);
    }
  }

  _applyCircleAndHole(roundProgress = 0) {
    const R = this.arenaRadiusNow() * this.arenaScale;
    const halfHole = this._holeHalfWidth(roundProgress);
    const holeOpen = halfHole > 0.015;

    for (const f of this.fighters) {
      if (!f.alive || f.falling) continue;
      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const dist = Math.hypot(dx, dy);
      // Per-flag radius so big flags reach the rim (and hole) sooner.
      const fr = this._flagRadiusFor(f);
      const limit = R - fr;
      if (dist < limit) continue;

      const ang = Math.atan2(dy, dx);
      // Angular pad from flag size — big flags can still fall into a small hole.
      const angPad = Math.min(0.55, fr * 3.2);
      const inHole =
        holeOpen && Math.abs(angleDiff(ang, this.holeAngle)) <= halfHole + angPad;

      if (inHole) {
        f.falling = true;
        f.pulse = 1;
        const nx = dx / (dist || 1);
        const ny = dy / (dist || 1);
        f.vx += nx * 0.45;
        f.vy += ny * 0.45;
        continue;
      }

      const nx = dx / (dist || 1);
      const ny = dy / (dist || 1);
      f.x = 0.5 + nx * limit;
      f.y = 0.5 + ny * limit;
      const vn = f.vx * nx + f.vy * ny;
      if (vn > 0) {
        f.vx -= 2.15 * vn * nx;
        f.vy -= 2.15 * vn * ny;
      }
      const tangent = Math.sign(angleDiff(this.holeAngle, ang)) || 1;
      f.vx += -ny * tangent * 0.12;
      f.vy += nx * tangent * 0.12;
    }
  }

  /** Hole half-width in radians. Final hole stage: shut for holeClosedSec, then open. */
  _holeHalfWidth(roundProgress = 0) {
    if (this.phase === "invasion" || this.finalStage === "invasion") {
      return 0; // sealed during alien invasion
    }
    if (this.phase === "sprint") {
      const w = CONFIG.sprintHoleWidth ?? CONFIG.holeWidth * 0.45;
      return (w * (1 + roundProgress * 0.35)) / 2;
    }
    if (this.phase === "main" || this.finalStage === "main") {
      const w = CONFIG.holeWidth * 0.55;
      return (w * (1 + roundProgress * 0.3)) / 2;
    }
    if (this.phase === "final" && this.finalStage === "hole") {
      const elapsed = this.roundStartedAt
        ? (performance.now() - this.roundStartedAt) / 1000
        : 0;
      if (elapsed < CONFIG.holeClosedSec) return 0;
      const openT = Math.min(
        1,
        (elapsed - CONFIG.holeClosedSec) / CONFIG.holeOpenSec
      );
      // Ease-in open from 0 → full hole width (+ late growth).
      const eased = openT * openT;
      return (CONFIG.holeWidth * (0.35 + eased * 0.65) * (1 + roundProgress * 0.35)) / 2;
    }
    return (CONFIG.holeWidth * (1 + roundProgress * 0.65)) / 2;
  }

  _markFallen(f) {
    if (!f.alive) return;
    f.alive = false;
    f.hp = 0;
    this.eliminated.push(f);
    this._fallOrder.push({ code: f.code, name: f.name, img: f.img });
    if (this.phase === "main" || this.phase === "invasion") {
      this._recordDeath(f);
    }
    playSfx("fall");
    this._emit("elim", `${f.name} fell through the hole!`);
    this._uiDirty = true;

    // Final hole: one elimination → round resets with remaining countries.
    if (
      this.phase === "final" &&
      this.finalStage === "hole" &&
      !this._finalElimLock
    ) {
      this._finalElimLock = true;
      for (const other of this.fighters) {
        if (other === f || !other.alive) continue;
        if (other.falling) {
          other.falling = false;
          other.vx *= 0.3;
          other.vy *= 0.3;
        }
      }
      const remaining = this._finalRemainingFromFall();
      if (remaining.length <= CONFIG.swissCutoff && remaining.length > 0) {
        this._beginSwissFromHole(
          remaining.map((c, i) => this._makeFighter(c, i, remaining.length))
        );
        return;
      }
      if (remaining.length <= 0) {
        this._emit("phase", "No flags left — restarting hole field.");
        this._finalElimLock = false;
        this._beginFinalHole(this.qualified);
        return;
      }
      this.phase = "between_rounds";
      this._pendingFinalReset = true;
      this._finalResetRemaining = remaining;
      this._betweenUntil =
        performance.now() + Math.max(1200, CONFIG.betweenRoundMs);
      this._emit(
        "phase",
        `${f.name} eliminated — ${remaining.length} left. Resetting round…`
      );
    }
  }

  _finalRemainingFromFall() {
    const out = new Set(this._fallOrder.map((r) => r.code));
    return (this.qualified || []).filter((q) => !out.has(q.code));
  }

  _resetFinalHoleRound(remaining) {
    this._finalElimLock = false;
    this._pendingFinalReset = false;
    this.finalStage = "hole";
    this.phase = "final";
    this.round += 1;
    const list = shuffle(remaining);
    this.fighters = list.map((c, i) => {
      const f = this._makeFighter(c, i, list.length);
      f.qualified = true;
      return f;
    });
    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    this._uiDirty = true;
    this._emit(
      "phase",
      `FINAL hole — ${this.fighters.length} remaining. Fall = out, then reset.`
    );
    this._publishLive();
  }

  _battleEliminate(loser, winner) {
    if (!loser.alive) return;
    loser.alive = false;
    loser.hp = 0;
    // Main / Invasion / Final 4: ranking uses last-death sequence (revives reset).
    if (
      this.phase === "main" ||
      this.phase === "invasion" ||
      this.finalStage === "main" ||
      this.finalStage === "invasion" ||
      this.finalStage === "battle"
    ) {
      this._recordDeath(loser);
      if (this.finalStage === "battle") {
        this._battleElimOrder.push({
          code: loser.code,
          name: loser.name,
          img: loser.img,
        });
      }
      this.eliminated.push(loser);
    } else if (this.finalStage === "swiss") {
      /* match-only — no ranking push */
    } else {
      this.eliminated.push(loser);
    }
    if (winner) winner.pulse = 1;
    this._emit(
      "elim",
      `${loser.name} eliminated${winner ? ` by ${winner.name}` : ""}`
    );
    this._uiDirty = true;

    if (this.finalStage === "swiss" && !this._swissMatchOver) {
      this._swissMatchOver = true;
      this._recordSwissMatchResult(winner, loser);
    }
  }

  _recordSwissMatchResult(winner, loser) {
    // +1 only for the win; loser gets 0 this match (pool score unchanged).
    if (winner) {
      const row = (this._swissPool || []).find((p) => p.code === winner.code);
      if (row) {
        row.points = (Number(row.points) || 0) + 1;
        winner.points = row.points;
      } else {
        winner.points = (Number(winner.points) || 0) + 1;
      }
      this._emit(
        "phase",
        `${winner.name} wins 1v1 (+1) · ${loser?.name || "opponent"} +0`
      );
    }
    this.phase = "between_rounds";
    this._pendingSwissPair = true;
    this._betweenUntil =
      performance.now() + Math.max(900, CONFIG.betweenRoundMs);
  }

  _checkBattleStage() {
    if (this.finalStage === "swiss") {
      if (this._swissMatchOver) return;
      const alive = this.fighters.filter((f) => f.alive);
      if (alive.length === 1) {
        const winner = alive[0];
        const loser = this.fighters.find((f) => f !== winner);
        this._swissMatchOver = true;
        this._recordSwissMatchResult(winner, loser);
      } else if (alive.length === 0) {
        this._swissMatchOver = true;
        this._pendingSwissPair = true;
        this.phase = "between_rounds";
        this._betweenUntil =
          performance.now() + Math.max(900, CONFIG.betweenRoundMs);
      }
      return;
    }
    if (this.finalStage === "battle") {
      const alive = this.fighters.filter((f) => f.alive);
      if (alive.length === 1) {
        this._onLastFlag(alive[0]);
      } else if (alive.length === 0) {
        const last =
          this._battleElimOrder[this._battleElimOrder.length - 1] ||
          this.eliminated[this.eliminated.length - 1];
        if (last) this._onLastFlag(last);
      }
    }
  }

  _finishSwissRound() {
    this.swissRound += 1;
    const need = Math.max(1, CONFIG.swissRounds);
    const short = (this._swissPool || []).filter(
      (p) => (Number(p.played) || 0) < need
    );
    if (!short.length) {
      this._emit(
        "phase",
        `Swiss complete — every country played ${need} matches.`
      );
      this.phase = "between_rounds";
      this._pendingSwissCut = true;
      this._betweenUntil =
        performance.now() + Math.max(1600, CONFIG.betweenRoundMs);
      return;
    }
    this._emit(
      "phase",
      `Swiss round ${this.swissRound} done · ${short.length} still need ${need} matches — continuing.`
    );
    this.phase = "between_rounds";
    this._pendingSwissNext = true;
    this._betweenUntil =
      performance.now() + Math.max(1200, CONFIG.betweenRoundMs);
  }

  _beginSwissFromHole(standingFighters) {
    this._finalElimLock = false;
    const list = standingFighters
      .map((f) => ({
        code: f.code,
        name: f.name,
        img: f.img,
        points: Number(f.points) || 0,
        played: 0,
      }))
      .slice(0, CONFIG.swissCutoff);
    this._emit(
      "phase",
      `${list.length} remain — Swiss 1v1 begins (every country plays ${CONFIG.swissRounds} matches · +1 per win).`
    );
    this.swissRound = 0;
    this._swissPool = list;
    this._swissPairQueue = [];
    this._swissCut = [];
    this._battleElimOrder = [];
    this.phase = "between_rounds";
    this.finalStage = "swiss";
    this._pendingSwissNext = true;
    this._betweenUntil =
      performance.now() + Math.max(1800, CONFIG.betweenRoundMs);
    this._uiDirty = true;
    this._publishLive();
  }

  _beginSwissRound() {
    const pool = this._swissPool || [];
    if (pool.length < 2) {
      this._cutSwissAndBeginBattle();
      return;
    }
    this.finalStage = "swiss";
    this.phase = "final";
    this.round += 1;
    this.arenaScale = 1;
    this._swissMatchOver = false;

    // Prefer pairing countries that still need matches; others can sit out.
    const need = Math.max(1, CONFIG.swissRounds);
    const needing = shuffle(
      pool.filter((p) => (Number(p.played) || 0) < need).map((p) => ({ ...p }))
    );
    const rest = shuffle(
      pool.filter((p) => (Number(p.played) || 0) >= need).map((p) => ({ ...p }))
    );
    // Fill to even count so as many needing players as possible get a match.
    const shuffled = [...needing];
    while (shuffled.length % 2 === 1 && rest.length) {
      shuffled.push(rest.pop());
    }
    if (shuffled.length < 2) {
      // Everyone already at quota (or only one left needing) — cut.
      this._cutSwissAndBeginBattle();
      return;
    }
    if (shuffled.length % 2 === 1) {
      // Still odd: give the highest-played needing country a sit-out (not a bye point).
      shuffled.sort(
        (a, b) => (Number(b.played) || 0) - (Number(a.played) || 0)
      );
      shuffled.pop();
    }
    const pairs = [];
    const order = shuffle(shuffled);
    for (let i = 0; i < order.length; i += 2) {
      pairs.push([order[i], order[i + 1]]);
    }
    this._swissPairQueue = pairs;
    this._emit(
      "phase",
      `SWISS set ${this.swissRound + 1} — ${pairs.length}× 1v1 · need ${need} matches each`
    );
    this._startNextSwissPair();
  }

  _startNextSwissPair() {
    this._swissMatchOver = false;
    if (!this._swissPairQueue.length) {
      this._finishSwissRound();
      return;
    }
    const [a, b] = this._swissPairQueue.shift();
    this.finalStage = "swiss";
    this.phase = "final";
    this.arenaScale = 1;
    this.roundStartedAt = performance.now();
    for (const c of [a, b]) {
      const row = this._swissPool.find((p) => p.code === c.code);
      if (row) row.played = (Number(row.played) || 0) + 1;
    }
    const pair = [a, b];
    const cap = this._battleMaxSpeed();
    this.fighters = pair.map((c, i) => {
      const f = this._makeFighter(c, i, 2);
      f.qualified = true;
      f.points = Number(
        this._swissPool.find((p) => p.code === c.code)?.points ?? c.points
      ) || 0;
      f.hp = CONFIG.baseHp;
      f.maxHp = CONFIG.baseHp;
      f.hitCd = 0;
      const dir = i === 0 ? 0 : Math.PI;
      const sp = rand(cap * 0.75, cap);
      f.vx = Math.cos(dir) * sp;
      f.vy = Math.sin(dir + rand(-0.4, 0.4)) * sp * 0.35;
      return f;
    });
    // Place them opposite each other for a clean 1v1.
    this.fighters[0].x = 0.35;
    this.fighters[0].y = 0.5;
    this.fighters[1].x = 0.65;
    this.fighters[1].y = 0.5;
    this._uiDirty = true;
    this._emit(
      "phase",
      `1v1 · ${a.name} vs ${b.name} · scores ${this.fighters[0].points}–${this.fighters[1].points}`
    );
    this._publishLive();
  }

  _cutSwissAndBeginBattle() {
    const ranked = [...(this._swissPool || [])].sort(
      (a, b) => b.points - a.points || a.name.localeCompare(b.name)
    );
    const targetKeep = Math.max(1, CONFIG.swissCutoff - CONFIG.swissEliminate);
    const keepN = Math.min(ranked.length, targetKeep);
    const kept = ranked.slice(0, keepN);
    const cut = ranked.slice(keepN);
    // Cut players are ranked later by average Qualifying place (not Swiss points).
    this._swissCut = cut.map((c) => ({
      code: c.code,
      name: c.name,
      img: c.img,
      points: Number(c.points) || 0,
    }));
    for (const c of cut) {
      this._emit(
        "elim",
        `${c.name} eliminated after Swiss (score ${c.points}).`
      );
    }
    this._emit(
      "phase",
      `Swiss cut — top ${kept.length} advance to last-flag battling.`
    );
    this._battleElimOrder = [];
    this._beginFinalBattle(kept);
  }

  _beginFinalBattle(list) {
    const field =
      list?.length > 0
        ? list
        : (this._swissPool || this.qualified || []).slice(0, 4);
    this.finalStage = "battle";
    this.phase = "final";
    this.round += 1;
    this.arenaScale = 1;
    this._battleElimOrder = [];
    this.fighters = shuffle(field).map((c, i) => {
      const f = this._makeFighter(c, i, field.length);
      f.qualified = true;
      f.points = Number(c.points) || 0;
      f.hp = CONFIG.baseHp;
      f.maxHp = CONFIG.baseHp;
      f.hitCd = 0;
      return f;
    });
    this.roundStartedAt = performance.now();
    this._uiDirty = true;
    this._emit(
      "phase",
      `FINAL BATTLE — ${this.fighters.length} flags · 100 HP · −${CONFIG.hitDamage} per hit`
    );
    this._publishLive();
  }

  _beginFinalHole(countries) {
    const list = shuffle(countries || this.qualified);
    this.finalStage = "hole";
    this.phase = "final";
    this.round += 1;
    this._finalElimLock = false;
    this._pendingFinalReset = false;
    // Fresh Final tracking — do not carry Qualifying eliminations into ranks.
    this.eliminated = [];
    this._fallOrder = [];
    this._swissCut = [];
    this._battleElimOrder = [];
    this.fighters = list.map((c, i) => {
      const f = this._makeFighter(c, i, list.length);
      f.qualified = true;
      return f;
    });
    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    this._uiDirty = true;
    this._emit(
      "phase",
      `FINAL — hole circle · ${list.length} flags. Fall = out, round resets.`
    );
    this._publishLive();
  }

  _finishQualifyingStream() {
    this._pendingQualComplete = false;
    this.phase = "qualifying_complete";
    this.finalStage = null;
    this.finalLiveAt = null;
    this.fighters = [];

    // Same livestream continues into Final — do not schedule a second stream.
    if (this.stream) {
      this.stream.mode = "qualifying";
      this.stream.status = "live";
      this.stream.qualified = this.qualified.map((q) => ({
        code: q.code,
        name: q.name,
        img: q.img,
      }));
      this.stream.endedAt = null;
      this.stream.nextFinalId = null;
      this.stream.nextFinalAt = null;
      saveStream(this.stream);
    }

    this._pendingUnifiedFinal = true;
    this._betweenUntil =
      performance.now() + Math.max(4000, CONFIG.finalistsRevealMs || 12_000);
    this._publishLive();
    this._emit(
      "phase",
      `Qualifying complete — ${this.qualified.length} finalists. Final starts next.`
    );
    this._uiDirty = true;
  }

  _rankingFromFallOrder(winner) {
    const ranking = [];
    if (winner) {
      ranking.push({
        rank: 1,
        code: winner.code,
        name: winner.name,
        img: winner.img,
      });
    }
    // Last fallen = rank 2, first fallen = last place
    const reversed = [...this._fallOrder].reverse();
    let rank = ranking.length + 1;
    for (const row of reversed) {
      ranking.push({ rank: rank++, ...row });
    }
    for (const e of [...this.eliminated].reverse()) {
      if (ranking.some((r) => r.code === e.code)) continue;
      if (winner && e.code === winner.code) continue;
      ranking.push({
        rank: rank++,
        code: e.code,
        name: e.name,
        img: e.img,
      });
    }
    return ranking;
  }

  /**
   * Final ranking for the stream:
   * 1) Invasion champion (#1)
   * 2) Main last-standing points (desc; earlier first point wins ties)
   * 3) Invasion death order / survivors as fallback
   */
  _buildFinalRanking(winner) {
    const ranking = [];
    const seen = new Set();
    const push = (row, extra = {}) => {
      if (!row?.code || seen.has(row.code)) return;
      if (winner && row.code === winner.code && ranking.length) return;
      seen.add(row.code);
      ranking.push({
        rank: ranking.length + 1,
        code: row.code,
        name: row.name,
        img: row.img,
        ...extra,
      });
    };

    if (winner) {
      const wPts = this.mainRoundPoints.get(winner.code) || 0;
      push(
        {
          code: winner.code,
          name: winner.name,
          img: winner.img,
        },
        wPts ? { mainPoints: wPts } : {}
      );
    }

    // Main points decide the rest of the final board.
    for (const row of this._mainPointLeaders(0)) {
      push(row, { mainPoints: row.points });
    }

    // Invasion death order for anyone without Main points.
    if (this._deathSeq?.length) {
      for (const row of [...this._deathSeq].reverse()) push(row);
    } else {
      for (const row of [...this._battleElimOrder].reverse()) push(row);
      for (const row of [...this._fallOrder].reverse()) push(row);
    }

    for (const f of this.fighters) {
      if (f.alive) push(f);
    }
    for (const q of this.qualified || []) push(q);

    return ranking;
  }

  _recordRound(winner, type) {
    if (!this.stream) return;
    const entry = {
      round: this.round,
      type,
      qualifier: winner
        ? { code: winner.code, name: winner.name, img: winner.img }
        : null,
      ranking: this._rankingFromFallOrder(winner),
      at: new Date().toISOString(),
    };
    this.stream.rounds.push(entry);
    this.stream.qualified = this.qualified.map((q) => ({
      code: q.code,
      name: q.name,
      img: q.img,
    }));
    saveStream(this.stream);
    this._publishLive();
  }

  _onLastFlag(flag) {
    if (this.phase === "qualifying") {
      this._qualify(flag);
      return;
    }
    if (
      this.phase === "main" ||
      this.phase === "invasion" ||
      this.phase === "final" ||
      this.finalStage === "battle" ||
      this.finalStage === "main" ||
      this.finalStage === "invasion"
    ) {
      this.winner = flag;
      this.phase = "finished";
      this.finalStage = null;
      this.aliens = [];
      this.arenaEvent = null;
      // Keep the loop running so the winner banner stays live for the hold.
      this._winnerHoldDone = false;
      const revealMs = Math.max(1000, CONFIG.winRevealMs || 3000);
      const holdMs = Math.max(5000, CONFIG.winnerHoldMs || 60_000);
      const now = performance.now();
      // Pause everything for the rank-change reveal, then continue champion hold.
      this._winRevealUntil = now + revealMs;
      this._winnerHoldUntil = now + revealMs + holdMs;

      // Championship rank change (+1 win) before we persist this stream's win.
      try {
        this.rankReveal = computeWinRankReveal(
          listStreams(),
          COUNTRIES,
          { code: flag.code, name: flag.name, img: flag.img },
          this.stream
        );
      } catch (err) {
        console.warn("[rank-reveal]", err?.message || err);
        this.rankReveal = {
          code: flag.code,
          name: flag.name,
          img: flag.img,
          fromRank: null,
          toRank: 1,
          points: 1,
          prevPoints: 0,
          delta: null,
          firstWin: true,
        };
      }

      const pointAt = new Date().toISOString();
      if (this.stream) {
        this.stream.mode = "final";
        this.stream.status = "winner_hold";
        this.stream.final = {
          ranking: this._buildFinalRanking(flag),
          winner: { code: flag.code, name: flag.name, img: flag.img },
          at: pointAt,
          pointAt,
          scoring: "wins_v1",
          rules: "opening_main_invasion",
          rankingRules: {
            primary: "main_round_points",
            note: "Invasion champion #1; others by Main last-standing points (earlier first point wins ties)",
          },
          mainRoundPoints: Object.fromEntries(this.mainRoundPoints || []),
          pollPlaces: null,
        };
        this.stream.winner = this.stream.final.winner;
        this.stream.qualified = this.qualified.map((q) => ({
          code: q.code,
          name: q.name,
          img: q.img,
        }));
        // Do NOT set endedAt yet — stream stays live through the hold.
        this.stream.endedAt = null;
        saveStream(this.stream);
        this._publishLive({
          winnerHoldRemainingMs: Math.max(
            0,
            this._winnerHoldUntil - performance.now()
          ),
          rankReveal: this.rankReveal,
        });
      }
      const rr = this.rankReveal;
      const rankLine =
        rr?.fromRank != null
          ? `#${rr.fromRank} → #${rr.toRank}`
          : `→ #${rr?.toRank ?? 1}`;
      this._emit(
        "rank_reveal",
        `${flag.name} +1 win · ${rankLine} (${rr?.points ?? 1} pts)`
      );
      this._emit("winner", `${flag.name} is the LAST FLAG STANDING!`);
      this._emit(
        "phase",
        `Rank reveal · ${Math.round(revealMs / 1000)}s · then champion hold`
      );
      this._uiDirty = true;
      this._flushUi(true);
    }
  }

  /** After the champion hold: freeze poll, mark stream ended, stop the loop. */
  _completeWinnerHold() {
    this._winnerHoldDone = true;
    this._winnerHoldUntil = 0;
    this.rankReveal = null;
    this._winRevealUntil = 0;
    if (this.stream && this.winner) {
      const poll = getLocalPoll(this.stream.id);
      const pollPlaces = rankPollPlaces(poll);
      closeLocalPoll(this.stream.id);
      this.stream.status = "finished";
      this.stream.endedAt = new Date().toISOString();
      if (this.stream.final) {
        this.stream.final.pollPlaces = pollPlaces;
        this.stream.final.heldAt = this.stream.endedAt;
      }
      saveStream(this.stream);
      this._publishLive();
      if (pollPlaces.length) {
        const top = pollPlaces
          .map((p) => `${p.rank}.${p.name}(+${p.points})`)
          .join(" · ");
        this._emit("phase", `Poll bonus locked — ${top}`);
      }
    }
    this._emit("phase", "Stream ending — thanks for watching!");
    this._uiDirty = true;
    this._flushUi(true);
    this.stopLoop();
  }

  _qualify(flag) {
    if (this.qualified.some((q) => q.code === flag.code)) return;
    flag.qualified = true;
    flag.alive = true;
    flag.falling = false;
    this.qualified.push({
      code: flag.code,
      name: flag.name,
      img: flag.img,
      id: flag.code,
    });
    this._recordRound(flag, "qualifying");
    this._emit(
      "qualify",
      `${flag.name} QUALIFIED for the Final! (Round ${this.round}) · ${this.qualified.length} total`
    );

    // No qualifier cap — keep running until the 30:00 clock ends.
    this._uiDirty = true;

    if (this.qualifyingExpired) {
      this.phase = "between_rounds";
      this._betweenUntil = performance.now() + CONFIG.betweenRoundMs;
      this._pendingQualComplete = true;
      return;
    }

    this.phase = "between_rounds";
    this._betweenUntil = performance.now() + CONFIG.betweenRoundMs;
  }

  _startNextQualifyingRound() {
    if (this._pendingQualComplete || this.qualifyingExpired) {
      this._finishQualifyingStream();
      return;
    }

    const remaining = this._remainingCountries();
    if (remaining.length <= 1) {
      if (remaining.length === 1) {
        const last = this._makeFighter(remaining[0], 0, 1);
        this.fighters = [last];
        this._qualify(last);
        return;
      }
      // Everyone already qualified — hold until the clock ends.
      this.phase = "qualifying_hold";
      this._emit(
        "phase",
        "Every country has qualified — holding until qualifying clock ends."
      );
      this._uiDirty = true;
      this._publishLive();
      return;
    }

    this._beginRound(remaining);
  }

  _beginFinal() {
    this._pendingQualComplete = false;
    // Do not carry Qualifying eliminations into Final ranking.
    this.eliminated = [];
    this._fallOrder = [];
    this._swissCut = [];
    this._battleElimOrder = [];
    if (!this.qualified.length) {
      this._emit("phase", "No qualifiers — sudden-death field.");
      this.qualified = shuffle(COUNTRIES)
        .slice(0, Math.min(16, COUNTRIES.length))
        .map((c) => ({
          code: c.code,
          name: c.name,
          img: flagUrl(c.code, 80),
          id: c.code,
        }));
      if (this.stream) {
        this.stream.qualified = this.qualified.map((q) => ({
          code: q.code,
          name: q.name,
          img: q.img,
        }));
      }
    }

    // Poll opens at battle start; do not re-init here (votes must survive).
    this._ensureBattlePoll();
    if (this.qualified.length <= CONFIG.swissCutoff) {
      this._beginSwissFromHole(
        this.qualified.map((c, i) => this._makeFighter(c, i, this.qualified.length))
      );
    } else {
      this._beginFinalHole(this.qualified);
    }
  }

  _publishLive(extra = {}) {
    setLiveSnapshot({
      streamId: this.stream?.id || null,
      mode: this.streamMode,
      phase: this.phase,
      finalStage: this.finalStage,
      round: this.round,
      swissRound: this.swissRound,
      qualified: this.qualified,
      standing: this.standing().map((f) => ({
        code: f.code,
        name: f.name,
        img: f.img,
        hp: f.hp,
        points: f.points,
      })),
      winner: this.winner
        ? { code: this.winner.code, name: this.winner.name, img: this.winner.img }
        : null,
      streamStatus: this.stream?.status || null,
      endedAt: this.stream?.endedAt || null,
      winnerHoldRemainingMs: this.winnerHoldRemainingMs(),
      qualifyingRemainingMs: this.qualifyingRemainingMs(),
      sprintRemainingMs: this.sprintRemainingMs(),
      mainRemainingMs: this.mainRemainingMs(),
      arenaEvent: this.arenaEvent
        ? {
            type: this.arenaEvent.type,
            label: this.arenaEvent.label,
            endsAt: this.arenaEvent.endsAt,
            hunterCode: this.arenaEvent.hunterCode || null,
          }
        : null,
      nextEventAt: this.nextEventAt || 0,
      sprintActive:
        this.phase === "sprint" ||
        this._pendingSprintReset ||
        this._pendingSprintEnd,
      mainRoundPoints: Object.fromEntries(this.mainRoundPoints || []),
      recentMainWins: (this.recentMainWins || []).slice(0, 12),
      finalLiveAt: this.finalLiveAt || extra.finalLiveAt || null,
      updatedAt: Date.now(),
      ...extra,
    });
  }

  winnerHoldRemainingMs(now = performance.now()) {
    if (!this._winnerHoldUntil || this._winnerHoldDone || !this.winner) return 0;
    return Math.max(0, this._winnerHoldUntil - now);
  }

  _emit(type, text) {
    this.events.unshift({ type, text, at: Date.now() });
    if (this.events.length > 40) this.events.length = 40;
    this._uiDirty = true;
  }

  qualifyingRemainingMs(now = performance.now()) {
    if (this.phase === "idle") return CONFIG.qualifyingMs;
    if (
      this.phase !== "qualifying" &&
      this.phase !== "between_rounds" &&
      this.phase !== "qualifying_hold"
    ) {
      return 0;
    }
    // During Final between-rounds, don't show qualifying clock.
    if (this.streamMode === "final") return 0;
    // Sprint between-rounds uses the Sprint clock, not Qualifying.
    if (this._pendingSprintReset || this._pendingSprintEnd) return 0;
    if (!this.qualifyingEndsAt) return CONFIG.qualifyingMs;
    return Math.max(0, this.qualifyingEndsAt - now);
  }

  sprintRemainingMs(now = performance.now()) {
    if (this.phase === "sprint") {
      if (!this.sprintEndsAt) return CONFIG.sprintMs;
      return Math.max(0, this.sprintEndsAt - now);
    }
    if (
      this.phase === "between_rounds" &&
      (this._pendingSprintReset || this._pendingSprintEnd)
    ) {
      if (!this.sprintEndsAt) return 0;
      return Math.max(0, this.sprintEndsAt - now);
    }
    return 0;
  }

  mainRemainingMs(now = performance.now()) {
    if (this.phase === "main") {
      if (!this.mainEndsAt) return CONFIG.mainMsMin;
      return Math.max(0, this.mainEndsAt - now);
    }
    if (this.phase === "between_rounds" && this._pendingMainReset) {
      if (!this.mainEndsAt) return 0;
      return Math.max(0, this.mainEndsAt - now);
    }
    return 0;
  }

  eventRemainingMs(now = performance.now()) {
    if (!this.arenaEvent?.endsAt) return 0;
    return Math.max(0, this.arenaEvent.endsAt - now);
  }

  nextEventRemainingMs(now = performance.now()) {
    if (this.phase !== "main" || this.arenaEvent) return 0;
    if (!this.nextEventAt) return 0;
    return Math.max(0, this.nextEventAt - now);
  }

  standing() {
    return this.fighters.filter((f) => f.alive && !f.falling);
  }

  boardFlags() {
    // Opening: recent spawn-round wins.
    if (
      this.phase === "sprint" ||
      (this.phase === "between_rounds" &&
        (this._pendingSprintReset || this._pendingSprintEnd))
    ) {
      return this.recentSprintWins || [];
    }
    // Main: last-standing point leaders (points decide final ranking).
    if (
      this.phase === "main" ||
      (this.phase === "between_rounds" && this._pendingMainReset)
    ) {
      const leaders = this._mainPointLeaders(24);
      if (leaders.length) return leaders;
      return this.recentMainWins || [];
    }
    // Invasion: elimination board (most recent deaths first).
    if (this.phase === "invasion") {
      const deaths = [...(this._deathSeq || [])].reverse().slice(0, 24);
      if (deaths.length) return deaths;
      return this.fighters.filter((f) => f.alive).slice(0, 16);
    }
    // Swiss: top board shows the current Final-4 cut line (top 4 by score).
    if (this._swissBoardActive()) {
      return this._swissBoardLeaders(4);
    }
    if (
      this.phase === "qualifying" ||
      this.phase === "qualifying_hold" ||
      this.phase === "qualifying_complete" ||
      this.phase === "idle" ||
      (this.phase === "between_rounds" && this.streamMode !== "final")
    ) {
      return this.qualified;
    }
    if (this.phase === "finished" && this.streamMode === "qualifying") {
      return this.qualified;
    }
    return this.fighters.filter((f) => f.alive);
  }

  _swissBoardActive() {
    if (!this._swissPool?.length) return false;
    return (
      this.finalStage === "swiss" ||
      this._pendingSwissNext ||
      this._pendingSwissPair ||
      this._pendingSwissCut
    );
  }

  /** Countries currently sitting inside the Final-4 cut by Swiss score. */
  _swissBoardLeaders(n = 4) {
    const keepN = Math.max(
      1,
      Math.min(
        n,
        CONFIG.swissCutoff - CONFIG.swissEliminate,
        this._swissPool?.length || 0
      )
    );
    return [...(this._swissPool || [])]
      .sort(
        (a, b) =>
          (Number(b.points) || 0) - (Number(a.points) || 0) ||
          String(a.name || "").localeCompare(String(b.name || ""))
      )
      .slice(0, keepN)
      .map((c) => ({
        code: c.code,
        name: c.name,
        img: c.img || flagUrl(c.code, 80),
        points: Number(c.points) || 0,
        played: Number(c.played) || 0,
      }));
  }

  holeStyle() {
    const deg = (this.holeAngle * 180) / Math.PI;
    const elapsed = this.roundStartedAt
      ? (performance.now() - this.roundStartedAt) / 1000
      : 0;
    const t = Math.min(1, elapsed / CONFIG.shrinkDurationSec);
    const battling =
      this.finalStage === "swiss" || this.finalStage === "battle";
    let width = 0;
    if (this.phase === "invasion" || this.finalStage === "invasion") {
      width = 0;
    } else if (this.phase === "main" || this.finalStage === "main") {
      width = this._holeHalfWidth(t) * 2;
    } else if (
      !battling &&
      (this.phase === "sprint" ||
        this.phase === "qualifying" ||
        this.phase === "final")
    ) {
      width = this._holeHalfWidth(t) * 2;
    } else if (!battling) {
      width = CONFIG.holeWidth;
    }
    return {
      rotateDeg: deg,
      widthDeg: (width * 180) / Math.PI,
      radiusPct: this.arenaRadiusNow() * this.arenaScale * 100,
    };
  }
}
