import { COUNTRIES, flagUrl } from "./countries.js";
import {
  newStreamId,
  saveStream,
  setLiveSnapshot,
  initLocalPoll,
} from "./store.js";

/**
 * @typedef {"idle" | "intermission" | "qualifying" | "qualifying_hold" | "between_rounds" | "final" | "finished"} Phase
 */

export const CONFIG = {
  qualifyingMs: 30 * 60 * 1000,
  /** Must match CSS --rim / SVG circle (42% of the square arena). */
  arenaRadius: 0.42,
  holeWidth: 0.85,
  holeSpeed: 1.8,
  flagRadius: 0.028,
  maxSpeed: 1.15,
  betweenRoundMs: 1400,
  intermissionMs: 60 * 1000,
  pushStrength: 0.8,
  outwardForce: 0.35,
  shrinkMinScale: 0.68,
  shrinkDurationSec: 40,
  /** Skip full UI notifications; physics still every frame. */
  uiThrottleMs: 200,
};

const params = new URLSearchParams(location.search);
if (params.has("demo")) {
  const sec = Number(params.get("demo")) || 45;
  CONFIG.qualifyingMs = sec * 1000;
  CONFIG.betweenRoundMs = 600;
  CONFIG.intermissionMs = Math.min(CONFIG.intermissionMs, 8_000);
  CONFIG.holeSpeed = 2.4;
  CONFIG.holeWidth = 1.0;
  CONFIG.maxSpeed = 1.45;
  CONFIG.outwardForce = 0.5;
  CONFIG.shrinkDurationSec = 18;
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
    this._fallOrder = [];
    this._betweenUntil = 0;
    this._pendingFinal = false;
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
    this._fallOrder = [];
    this._betweenUntil = 0;
    this._pendingFinal = false;
    this._uiDirty = true;
    this._emit("reset", "All countries ready. Last flag in the circle qualifies.");
    this._flushUi(true);
  }

  _makeFighter(country, index, total) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 + rand(-0.04, 0.04);
    const radius = rand(0.05, CONFIG.arenaRadius * 0.68);
    const speed = rand(CONFIG.maxSpeed * 0.45, CONFIG.maxSpeed);
    const dir = rand(0, Math.PI * 2);
    return {
      ...country,
      id: `${country.code}-${this.round}-${index}`,
      code: country.code,
      alive: true,
      qualified: false,
      falling: false,
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      img: flagUrl(country.code, 80),
      pulse: 0,
    };
  }

  start() {
    if (this.phase !== "idle" && this.phase !== "finished") return;
    this.reset();
    this.events = [];
    this.phaseStartedAt = performance.now();
    this.qualifyingEndsAt = 0;
    this.stream = {
      id: newStreamId(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      rounds: [],
      final: null,
      qualified: [],
      winner: null,
    };
    this._publishLive();
    this._beginIntermission("open");
    this._startLoop();
    this._flushUi(true);
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
      this._emit(
        "phase",
        `INTERMISSION — battle starts in ${Math.round(CONFIG.intermissionMs / 1000)}s`
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
        initLocalPoll(
          this.stream.id,
          this.qualified.map((q) => ({
            code: q.code,
            name: q.name,
            img: q.img,
          }))
        );
      }
      this._emit(
        "phase",
        `INTERMISSION — Final in ${Math.round(CONFIG.intermissionMs / 1000)}s · ${this.qualified.length} qualified`
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
        this._pendingFinal = true;
        this._emit("phase", "Qualifying time complete — Final next.");
        this._beginIntermission("final");
      }
      this.onFrame();
      this._flushUi();
      return;
    }

    if (this.phase === "between_rounds") {
      if (now >= this._betweenUntil) {
        if (this._pendingFinal) this._beginIntermission("final");
        else this._startNextQualifyingRound();
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
      if (standingNow.length === 1) {
        for (const f of this.fighters) {
          if (f.falling && f.alive) this._markFallen(f);
        }
        this._onLastFlag(standingNow[0]);
      } else if (alive.length === 0) {
        this._emit("phase", "Everyone fell — restarting round.");
        if (this.phase === "final") this._beginFinal();
        else this._startNextQualifyingRound();
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

  _moveFighters(dt, { physicsRim }) {
    const outward = physicsRim ? CONFIG.outwardForce : 0.03;
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

      const speed = Math.hypot(f.vx, f.vy);
      if (speed > CONFIG.maxSpeed) {
        f.vx = (f.vx / speed) * CONFIG.maxSpeed;
        f.vy = (f.vy / speed) * CONFIG.maxSpeed;
      } else if (speed < 0.2) {
        const dir = rand(0, Math.PI * 2);
        f.vx += Math.cos(dir) * 0.15;
        f.vy += Math.sin(dir) * 0.15;
      }
    }
  }

  _resolveCollisions() {
    const active = this.fighters.filter((f) => f.alive && !f.falling);
    const minDist = this._flagRadius() * 2.05;
    const cell = Math.max(minDist, 0.04);
    const grid = new Map();

    for (let i = 0; i < active.length; i++) {
      const f = active[i];
      const cx = Math.floor(f.x / cell);
      const cy = Math.floor(f.y / cell);
      const k = cx + "," + cy;
      let bucket = grid.get(k);
      if (!bucket) {
        bucket = [];
        grid.set(k, bucket);
      }
      bucket.push(i);
    }

    const checked = new Set();
    for (const [k, indices] of grid) {
      const [cx, cy] = k.split(",").map(Number);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const other = grid.get(cx + ox + "," + (cy + oy));
          if (!other) continue;
          for (const i of indices) {
            for (const j of other) {
              if (j <= i) continue;
              const pair = i + ":" + j;
              if (checked.has(pair)) continue;
              checked.add(pair);
              const a = active[i];
              const b = active[j];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dist = Math.hypot(dx, dy) || 0.0001;
              if (dist >= minDist) continue;
              const nx = dx / dist;
              const ny = dy / dist;
              const overlap = (minDist - dist) * 0.5;
              a.x -= nx * overlap;
              a.y -= ny * overlap;
              b.x += nx * overlap;
              b.y += ny * overlap;
              const avn = a.vx * nx + a.vy * ny;
              const bvn = b.vx * nx + b.vy * ny;
              const exchange = (avn - bvn) * CONFIG.pushStrength;
              a.vx -= exchange * nx;
              a.vy -= exchange * ny;
              b.vx += exchange * nx;
              b.vy += exchange * ny;
            }
          }
        }
      }
    }
  }

  _applyCircleAndHole(roundProgress = 0) {
    const R = CONFIG.arenaRadius * this.arenaScale;
    const halfHole = (CONFIG.holeWidth * (1 + roundProgress * 0.65)) / 2;
    const fr = this._flagRadius();

    for (const f of this.fighters) {
      if (!f.alive || f.falling) continue;
      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const dist = Math.hypot(dx, dy);
      const limit = R - fr;
      if (dist < limit) continue;

      const ang = Math.atan2(dy, dx);
      const inHole = Math.abs(angleDiff(ang, this.holeAngle)) <= halfHole;

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

  _markFallen(f) {
    if (!f.alive) return;
    f.alive = false;
    f.hp = 0;
    this.eliminated.push(f);
    this._fallOrder.push({ code: f.code, name: f.name, img: f.img });
    this._emit("elim", `${f.name} fell through the hole!`);
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
    if (this.phase === "final") {
      this.winner = flag;
      this.phase = "finished";
      this.stopLoop();
      if (this.stream) {
        this.stream.final = {
          ranking: this._rankingFromFallOrder(flag),
          winner: { code: flag.code, name: flag.name, img: flag.img },
          at: new Date().toISOString(),
        };
        this.stream.winner = this.stream.final.winner;
        this.stream.endedAt = new Date().toISOString();
        saveStream(this.stream);
        this._publishLive();
      }
      this._emit("winner", `${flag.name} is the LAST FLAG STANDING!`);
      this._uiDirty = true;
    }
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
    this._pendingFinal = this.qualifyingExpired;
    this._uiDirty = true;

    if (this.qualifyingExpired) {
      this.phase = "between_rounds";
      this._betweenUntil = performance.now() + CONFIG.betweenRoundMs;
      this._pendingFinal = true;
      return;
    }

    this.phase = "between_rounds";
    this._betweenUntil = performance.now() + CONFIG.betweenRoundMs;
  }

  _startNextQualifyingRound() {
    if (this._pendingFinal || this.qualifyingExpired) {
      this._beginIntermission("final");
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
    this._pendingFinal = false;
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
    }

    this.phase = "final";
    this.round += 1;
    const list = shuffle(this.qualified);
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
    if (this.stream) {
      initLocalPoll(
        this.stream.id,
        this.qualified.map((q) => ({
          code: q.code,
          name: q.name,
          img: q.img,
        }))
      );
    }
    this._emit(
      "phase",
      `FINAL — ${this.fighters.length} flags. Last Flag Standing!`
    );
    this._publishLive();
  }

  _publishLive() {
    setLiveSnapshot({
      streamId: this.stream?.id || null,
      phase: this.phase,
      round: this.round,
      qualified: this.qualified,
      standing: this.standing().map((f) => ({
        code: f.code,
        name: f.name,
        img: f.img,
      })),
      winner: this.winner
        ? { code: this.winner.code, name: this.winner.name, img: this.winner.img }
        : null,
      qualifyingRemainingMs: this.qualifyingRemainingMs(),
      intermissionRemainingMs: this.intermissionRemainingMs(),
      updatedAt: Date.now(),
    });
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
    if (
      this.phase === "qualifying" ||
      this.phase === "qualifying_hold" ||
      this.phase === "idle" ||
      this.phase === "between_rounds" ||
      this.phase === "intermission"
    ) {
      return this.qualified;
    }
    return this.fighters.filter((f) => f.alive);
  }

  holeStyle() {
    const deg = (this.holeAngle * 180) / Math.PI;
    const elapsed = this.roundStartedAt
      ? (performance.now() - this.roundStartedAt) / 1000
      : 0;
    const t = Math.min(1, elapsed / CONFIG.shrinkDurationSec);
    const width =
      this.phase === "qualifying" || this.phase === "final"
        ? CONFIG.holeWidth * (1 + t * 0.65)
        : CONFIG.holeWidth;
    return {
      rotateDeg: deg,
      widthDeg: (width * 180) / Math.PI,
      radiusPct: CONFIG.arenaRadius * this.arenaScale * 100,
    };
  }
}
