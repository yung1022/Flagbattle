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
  setPersistEnabled,
  seedTeststreamPollDemo,
} from "./store.js";
import { resolveApiBase, pagesDataUrl } from "./public.js";

/**
 * @typedef {"idle" | "intermission" | "qualifying" | "qualifying_hold" | "between_rounds" | "final" | "qualifying_complete" | "finished"} Phase
 * @typedef {"qualifying" | "final"} StreamMode
 * @typedef {"hole" | "swiss" | "battle" | null} FinalStage
 * @typedef {"qualifying" | "hole" | "swiss" | "final4" | null} TestStreamKind
 */

const params = new URLSearchParams(location.search);

/** Easy/teststream: qualifying | hole | swiss | final4 (no save / no config). */
export function normalizeTestStream(raw) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "" || v === "1" || v === "true" || v === "qual" || v === "qualifying") {
    return "qualifying";
  }
  if (v === "hole" || v === "final" || v === "final1" || v === "part1") return "hole";
  if (v === "swiss" || v === "part2") return "swiss";
  if (v === "final4" || v === "battle" || v === "last" || v === "part3") {
    return "final4";
  }
  return "qualifying";
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
  /** Qualifying rim — must match CSS --rim / SVG circle. */
  arenaRadius: 0.42,
  /** Final hole stage — larger circle; UI chrome is tightened to fit. */
  finalArenaRadius: 0.48,
  holeWidth: 0.85,
  holeSpeed: 1.8,
  /** Final: keep hole shut, then open gradually. */
  holeClosedSec: 5,
  holeOpenSec: 28,
  flagRadius: 0.028,
  maxSpeed: 1.15,
  /** Swiss 1v1 moves faster than hole / Final 4. */
  swissSpeedMult: 1.7,
  betweenRoundMs: 1400,
  intermissionMs: 60 * 1000,
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
   * Swiss / Final 4: if a bounce leaves a flag slower than this fraction of
   * max speed, nudge it back up so fights don't stall.
   */
  battleMinBounceSpeed: 0.78,
  /** Extra multiply applied on slow battle bounces (rim or flag). */
  battleBounceBoost: 1.55,
  /** After Final champion, keep the winner on screen before ending the stream. */
  winnerHoldMs: 60 * 1000,
  /** Brief finalists reveal before Final starts in the same livestream. */
  finalistsRevealMs: 12 * 1000,
  /** Skip full UI notifications; physics still every frame. */
  uiThrottleMs: 250,
};

function applyEasyTestConfig() {
  CONFIG.qualifyingMs = 90 * 1000;
  CONFIG.intermissionMs = 4 * 1000;
  CONFIG.betweenRoundMs = 500;
  CONFIG.holeSpeed = 2.4;
  CONFIG.holeWidth = 1.0;
  CONFIG.maxSpeed = 1.45;
  CONFIG.outwardForce = 0.5;
  CONFIG.shrinkDurationSec = 14;
  CONFIG.holeClosedSec = 2;
  CONFIG.holeOpenSec = 8;
  CONFIG.swissRounds = 5;
  CONFIG.swissSpeedMult = 1.85;
  CONFIG.battleRate = 5;
  CONFIG.finalistsRevealMs = 4 * 1000;
  CONFIG.winnerHoldMs = 8 * 1000;
}

if (params.has("demo")) {
  const sec = Number(params.get("demo")) || 45;
  CONFIG.qualifyingMs = sec * 1000;
  CONFIG.betweenRoundMs = 600;
  // Keep full 1:00 intermission even in demo — viewers need the beat.
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
    this.intermissionKind = null;
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
    this._betweenUntil = 0;
    this._pendingQualComplete = false;
    this._pendingSwissCut = false;
    this._pendingSwissNext = false;
    this._pendingSwissPair = false;
    this._pendingFinalReset = false;
    this._finalResetRemaining = null;
    this._finalElimLock = false;
    this._swissPairQueue = [];
    this._swissMatchOver = false;
    this._battleAccum = 0;
    this._winnerHoldUntil = 0;
    this._winnerHoldDone = false;
    this._pendingUnifiedFinal = false;
    this._raf = 0;
    this._lastTs = 0;
    this._lastUi = 0;
    this._uiDirty = true;
    this.onFrame = () => {};
    this.onChange = () => {};
  }

  reset() {
    this.stopLoop();
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
    this.intermissionKind = null;
    this.stream = null;
    this.streamMode = STREAM_MODE;
    this.finalStage = null;
    this.testStream = null;
    this.swissRound = 0;
    this.finalLiveAt = null;
    this._fallOrder = [];
    this._betweenUntil = 0;
    this._pendingQualComplete = false;
    this._pendingSwissCut = false;
    this._pendingSwissNext = false;
    this._pendingSwissPair = false;
    this._pendingFinalReset = false;
    this._finalResetRemaining = null;
    this._finalElimLock = false;
    this._swissPairQueue = [];
    this._swissMatchOver = false;
    this._battleAccum = 0;
    this._winnerHoldUntil = 0;
    this._winnerHoldDone = false;
    this._pendingUnifiedFinal = false;
    this._uiDirty = true;
    this._emit(
      "reset",
      this.streamMode === "final"
        ? "Final ready — hole (reset on fall) → Swiss 1v1 → last flag standing."
        : "Qualifying ready — last flag in the circle qualifies."
    );
    this._flushUi(true);
  }

  _makeFighter(country, index, total) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 + rand(-0.04, 0.04);
    const radius = rand(0.05, this.arenaRadiusNow() * 0.68);
    const speed = rand(CONFIG.maxSpeed * 0.45, CONFIG.maxSpeed);
    const dir = rand(0, Math.PI * 2);
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
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      img: flagUrl(country.code, 80),
      hitCd: 0,
    };
  }

  arenaRadiusNow() {
    return this.streamMode === "final" || this.finalStage
      ? CONFIG.finalArenaRadius
      : CONFIG.arenaRadius;
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
    return this.finalStage === "swiss" || this.finalStage === "battle";
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

    if (this.streamMode === "final") {
      await this._adoptScheduledFinalStream();
      if (!this.stream) {
        this.stream = {
          id: newStreamId(),
          mode: "final",
          status: "live",
          startedAt: new Date().toISOString(),
          endedAt: null,
          scheduledAt: null,
          rounds: [],
          final: null,
          qualified: [],
          winner: null,
          sourceStreamId: null,
        };
        await this._loadQualifiersFromHistory();
      }
      this.stream.status = "live";
      if (!this.stream.startedAt) this.stream.startedAt = new Date().toISOString();
      this.stream.mode = "final";
      this._publishLive();
      this._beginIntermission("final");
    } else {
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
      };
      this._publishLive();
      this._beginIntermission("open");
    }
    this._startLoop();
    this._flushUi(true);
  }

  /** Easy teststream — synthetic field, short timings, zero persistence. */
  _startTestStream(kind) {
    const mode =
      kind === "qualifying" ? "qualifying" : "final";
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
    };
    this._emit("phase", `TESTSTREAM · ${kind} (easy · no save)`);
    this._initTeststreamPoll();

    if (kind === "qualifying") {
      this._publishLive();
      this._beginIntermission("open");
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

  _beginIntermission(kind) {
    this.intermissionKind = kind;
    this.phase = "intermission";
    this._betweenUntil = performance.now() + CONFIG.intermissionMs;
    this.arenaScale = 1;
    this._uiDirty = true;
    if (kind === "open") {
      this.round = 0;
      this.fighters = shuffle(COUNTRIES).map((c, i) =>
        this._makeFighter(c, i, COUNTRIES.length)
      );
      // Open the winner poll for the whole battle (Qual + Final).
      if (this.stream) {
        initLocalPoll(
          this.stream.id,
          COUNTRIES.map((c) => ({
            code: c.code,
            name: c.name,
            img: flagUrl(c.code, 80),
          }))
        );
      }
      this._emit(
        "phase",
        `INTERMISSION — battle starts in ${Math.round(CONFIG.intermissionMs / 1000)}s · poll open (type a country or !vote)`
      );
    } else {
      const list = this.qualified.length
        ? this.qualified
        : shuffle(COUNTRIES).slice(0, 16);
      this.fighters = shuffle(list).map((c, i) => {
        const f = this._makeFighter(c, i, list.length);
        f.qualified = true;
        return f;
      });
      if (this.stream) {
        // Same-stream Final: keep the open Qualifying poll (votes carry over).
        const existing = getLocalPoll(this.stream.id);
        if (!existing?.options?.length) {
          const fromSource = this.stream.sourceStreamId
            ? transferPoll(this.stream.sourceStreamId, this.stream.id)
            : null;
          if (!fromSource?.options?.length) {
            initLocalPoll(
              this.stream.id,
              COUNTRIES.map((c) => ({
                code: c.code,
                name: c.name,
                img: flagUrl(c.code, 80),
              }))
            );
          }
        }
      }
      this._emit(
        "phase",
        `INTERMISSION — Final in ${Math.round(CONFIG.intermissionMs / 1000)}s · ${this.qualified.length} qualified · poll still open`
      );
    }
    for (const f of this.fighters) {
      f.vx *= 0.25;
      f.vy *= 0.25;
      f.falling = false;
      f.alive = true;
    }
    this._publishLive();
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

    if (this.phase === "intermission") {
      this._moveFighters(dt * 0.45, { physicsRim: false });
      if (now >= this._betweenUntil) {
        if (this.intermissionKind === "open") {
          this.qualifyingEndsAt = now + CONFIG.qualifyingMs;
          this._emit(
            "phase",
            "QUALIFYING — 30:00 on the clock. All non-qualified countries each round."
          );
          this._startNextQualifyingRound();
        } else {
          this._beginFinal();
        }
      }
      this.onFrame();
      this._flushUi();
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
        if (this._pendingQualComplete) {
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
        this._beginIntermission("final");
        this._flushUi(true);
        return;
      }
      this.onFrame();
      this._flushUi();
      return;
    }

    if (this.phase === "qualifying" || this.phase === "final") {
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
        this.phase === "final" &&
        (this.finalStage === "swiss" || this.finalStage === "battle");

      if (battling) {
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

        if (this.phase === "qualifying") {
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

  _moveFighters(dt, { physicsRim, solidRim = false }) {
    const outward = physicsRim ? CONFIG.outwardForce : 0.03;
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

      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.pulse > 0) f.pulse = Math.max(0, f.pulse - dt * 4);
      if (f.hitCd > 0) f.hitCd = Math.max(0, f.hitCd - dt);

      if (solidRim) {
        const fr = this._flagRadius();
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

    const minDist = this._flagRadius() * 2.05;
    const minSq = minDist * minDist;
    const cell = Math.max(minDist, 0.04);
    const inv = 1 / cell;
    if (!this._colGrid) this._colGrid = new Map();
    const grid = this._colGrid;
    grid.clear();

    for (let i = 0; i < n; i++) {
      const f = active[i];
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
    const fr = this._flagRadius();
    const holeOpen = halfHole > 0.02;

    for (const f of this.fighters) {
      if (!f.alive || f.falling) continue;
      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const dist = Math.hypot(dx, dy);
      const limit = R - fr;
      if (dist < limit) continue;

      const ang = Math.atan2(dy, dx);
      const inHole =
        holeOpen && Math.abs(angleDiff(ang, this.holeAngle)) <= halfHole;

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
    this.eliminated.push(loser);
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
        const last = this.eliminated[this.eliminated.length - 1];
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
    this.fighters = list.map((c, i) => {
      const f = this._makeFighter(c, i, list.length);
      f.qualified = true;
      return f;
    });
    this.holeAngle = rand(0, Math.PI * 2);
    this.roundStartedAt = performance.now();
    this.arenaScale = 1;
    this._fallOrder = [];
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
    // Append Swiss/battle eliminations not in fall order
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
    if (this.phase === "final" || this.finalStage === "battle") {
      this.winner = flag;
      this.phase = "finished";
      this.finalStage = null;
      // Keep the loop running so the winner banner stays live for the hold.
      this._winnerHoldDone = false;
      this._winnerHoldUntil =
        performance.now() + Math.max(5000, CONFIG.winnerHoldMs || 60_000);
      if (this.stream) {
        this.stream.mode = "final";
        this.stream.status = "winner_hold";
        this.stream.final = {
          ranking: this._rankingFromFallOrder(flag),
          winner: { code: flag.code, name: flag.name, img: flag.img },
          at: new Date().toISOString(),
          rules: "hole_swiss_battle",
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
          winnerHoldRemainingMs: Math.max(0, this._winnerHoldUntil - performance.now()),
        });
      }
      this._emit("winner", `${flag.name} is the LAST FLAG STANDING!`);
      this._emit(
        "phase",
        `Champion hold · ${Math.round((CONFIG.winnerHoldMs || 60_000) / 1000)}s before stream ends`
      );
      this._uiDirty = true;
      this._flushUi(true);
    }
  }

  /** After the champion hold: freeze poll, mark stream ended, stop the loop. */
  _completeWinnerHold() {
    this._winnerHoldDone = true;
    this._winnerHoldUntil = 0;
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
    this.intermissionKind = null;
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

    // Do NOT re-init the poll here — votes cast during final intermission
    // must survive until the stream ends. Poll opens once in intermission.
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
      intermissionRemainingMs: this.intermissionRemainingMs(),
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
    if (this.phase === "intermission" && this.intermissionKind === "open") {
      return CONFIG.qualifyingMs;
    }
    if (
      this.phase !== "qualifying" &&
      this.phase !== "between_rounds" &&
      this.phase !== "qualifying_hold"
    ) {
      return 0;
    }
    // During Final between-rounds, don't show qualifying clock.
    if (this.streamMode === "final") return 0;
    if (!this.qualifyingEndsAt) return CONFIG.qualifyingMs;
    return Math.max(0, this.qualifyingEndsAt - now);
  }

  intermissionRemainingMs(now = performance.now()) {
    if (this.phase !== "intermission") return 0;
    return Math.max(0, this._betweenUntil - now);
  }

  standing() {
    return this.fighters.filter((f) => f.alive && !f.falling);
  }

  boardFlags() {
    // Swiss: top board shows the current Final-4 cut line (top 4 by score).
    if (this._swissBoardActive()) {
      return this._swissBoardLeaders(4);
    }
    if (
      this.phase === "qualifying" ||
      this.phase === "qualifying_hold" ||
      this.phase === "qualifying_complete" ||
      this.phase === "idle" ||
      (this.phase === "between_rounds" && this.streamMode !== "final") ||
      (this.phase === "intermission" && this.intermissionKind === "open")
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
    if (!battling && (this.phase === "qualifying" || this.phase === "final")) {
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
