import { COUNTRIES, flagUrl } from "./countries.js";

/**
 * @typedef {"idle" | "intermission" | "qualifying" | "between_rounds" | "final" | "finished"} Phase
 */

export const CONFIG = {
  qualifyingMs: 30 * 60 * 1000,
  finalistSlots: 32,
  /** Playable circle radius in normalized arena coords (center = 0.5). */
  arenaRadius: 0.42,
  /** Angular width of the fall-through hole (radians). */
  holeWidth: 0.72,
  /** Hole rotation speed (rad/s). */
  holeSpeed: 0.95,
  /** Base physics radius; scaled down when many flags are present. */
  flagRadius: 0.028,
  maxSpeed: 0.42,
  /** Brief beat after a country qualifies mid-qualifying. */
  betweenRoundMs: 1600,
  /** Opening bumper + pre-final bumper. */
  intermissionMs: 60 * 1000,
  /** Soft body push strength between flags (no damage). */
  pushStrength: 0.85,
  /** Outward drift so flags hit the rim/hole sooner. */
  outwardForce: 0.11,
  /** Arena shrinks over a round to speed eliminations (fraction of radius). */
  shrinkMinScale: 0.72,
  shrinkDurationSec: 55,
};

const params = new URLSearchParams(location.search);
if (params.has("demo")) {
  const sec = Number(params.get("demo")) || 45;
  CONFIG.qualifyingMs = sec * 1000;
  CONFIG.betweenRoundMs = 700;
  CONFIG.intermissionMs = Math.min(CONFIG.intermissionMs, 8_000);
  CONFIG.holeSpeed = 1.35;
  CONFIG.holeWidth = 0.9;
  CONFIG.maxSpeed = 0.55;
  CONFIG.outwardForce = 0.18;
  CONFIG.shrinkDurationSec = 22;
  CONFIG.finalistSlots = Math.min(CONFIG.finalistSlots, 8);
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

/** Physics + render radius from how many flags are in the arena. */
export function flagSizeForCount(count) {
  const n = Math.max(1, count);
  // ~194 → tiny, ~32 → medium, ~8 → large
  const radius = Math.min(0.034, Math.max(0.012, 0.22 / Math.sqrt(n)));
  const px = Math.min(56, Math.max(14, 520 / Math.sqrt(n)));
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
    this.intermissionKind = null; // "open" | "final"
    this._betweenUntil = 0;
    this._pendingFinal = false;
    this._raf = 0;
    this._lastTs = 0;
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
    this._betweenUntil = 0;
    this._pendingFinal = false;
    this._emit("reset", "All countries ready. Last flag in the circle qualifies.");
    this.onChange();
  }

  _makeFighter(country, index, total) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 + rand(-0.04, 0.04);
    const radius = rand(0.06, CONFIG.arenaRadius * 0.7);
    const speed = rand(0.12, CONFIG.maxSpeed * 0.85);
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
    // Qualifying clock starts after the opening intermission.
    this.qualifyingEndsAt = 0;
    this._beginIntermission("open");
    this._startLoop();
    this.onChange();
  }

  _beginIntermission(kind) {
    this.intermissionKind = kind;
    this.phase = "intermission";
    this._betweenUntil = performance.now() + CONFIG.intermissionMs;
    this.arenaScale = 1;
    if (kind === "open") {
      // Preview: every country on the floor during the bumper.
      this.round = 0;
      this.fighters = shuffle(COUNTRIES).map((c, i) =>
        this._makeFighter(c, i, COUNTRIES.length)
      );
      this._emit(
        "phase",
        `INTERMISSION — battle starts in ${Math.round(CONFIG.intermissionMs / 1000)}s`
      );
    } else {
      // Showcase everyone who made the Final.
      const list = this.qualified.length
        ? this.qualified
        : shuffle(COUNTRIES).slice(0, 16);
      this.fighters = shuffle(list).map((c, i) => {
        const f = this._makeFighter(c, i, list.length);
        f.qualified = true;
        return f;
      });
      this._emit(
        "phase",
        `INTERMISSION — Final in ${Math.round(CONFIG.intermissionMs / 1000)}s · ${this.qualified.length} qualified`
      );
    }
    for (const f of this.fighters) {
      f.vx *= 0.2;
      f.vy *= 0.2;
      f.falling = false;
      f.alive = true;
    }
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
    this.phase = "qualifying";
    this._emit(
      "phase",
      `Round ${this.round} — ${list.length} flags in. Last one qualifies!`
    );
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
      // Gentle drift during bumper so the arena stays alive.
      this._moveFighters(dt * 0.35, { physicsRim: false });
      if (now >= this._betweenUntil) {
        if (this.intermissionKind === "open") {
          this.qualifyingEndsAt = now + CONFIG.qualifyingMs;
          this._emit(
            "phase",
            "QUALIFYING — all non-qualified countries each round. Last flag qualifies."
          );
          this._startNextQualifyingRound();
        } else {
          this._beginFinal();
        }
      }
      this.onChange();
      return;
    }

    if (this.phase === "between_rounds") {
      if (now >= this._betweenUntil) {
        if (this._pendingFinal) this._beginIntermission("final");
        else this._startNextQualifyingRound();
      }
      this.onChange();
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
      }

      const elapsed = (now - this.roundStartedAt) / 1000;
      const t = Math.min(1, elapsed / CONFIG.shrinkDurationSec);
      this.arenaScale =
        1 - (1 - CONFIG.shrinkMinScale) * (t * t);

      // Hole widens as the pack thins / round ages — faster qualifying.
      const standing = this.fighters.filter((f) => f.alive && !f.falling);
      const packBoost = 1 + Math.min(1.2, standing.length / 120);
      const lateBoost = 1 + t * 0.85;
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
          if (f.falling && f.alive) {
            f.alive = false;
            this.eliminated.push(f);
            this._emit("elim", `${f.name} fell through the hole!`);
          }
        }
        this._onLastFlag(standingNow[0]);
      } else if (alive.length === 0) {
        this._emit("phase", "Everyone fell — restarting round.");
        if (this.phase === "final") this._beginFinal();
        else this._startNextQualifyingRound();
      }
    }

    this.onChange();
  }

  _flagRadius() {
    const n = this.fighters.filter((f) => f.alive && !f.falling).length || this.fighters.length || 1;
    return flagSizeForCount(n).radius;
  }

  _moveFighters(dt, { physicsRim }) {
    const outward = physicsRim ? CONFIG.outwardForce : 0.02;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      if (f.falling) {
        const dx = f.x - 0.5;
        const dy = f.y - 0.5;
        const len = Math.hypot(dx, dy) || 1;
        f.vx += (dx / len) * 0.85 * dt;
        f.vy += (dy / len) * 0.85 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (Math.hypot(f.x - 0.5, f.y - 0.5) > 0.78) {
          f.alive = false;
          this.eliminated.push(f);
          this._emit("elim", `${f.name} fell through the hole!`);
        }
        continue;
      }

      // Mild centrifugal push toward the rim / hole.
      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const len = Math.hypot(dx, dy) || 1;
      f.vx += (dx / len) * outward * dt;
      f.vy += (dy / len) * outward * dt;

      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.pulse > 0) f.pulse = Math.max(0, f.pulse - dt * 3);

      const speed = Math.hypot(f.vx, f.vy);
      if (speed > CONFIG.maxSpeed) {
        f.vx = (f.vx / speed) * CONFIG.maxSpeed;
        f.vy = (f.vy / speed) * CONFIG.maxSpeed;
      } else if (speed < 0.08) {
        const dir = rand(0, Math.PI * 2);
        f.vx += Math.cos(dir) * 0.06;
        f.vy += Math.sin(dir) * 0.06;
      }
    }
  }

  _resolveCollisions() {
    const active = this.fighters.filter((f) => f.alive && !f.falling);
    const minDist = this._flagRadius() * 2.05;
    // Spatial-ish: only O(n²) but n drops fast; for ~194 keep cheap early-outs.
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
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
        a.pulse = 0.45;
        b.pulse = 0.45;
      }
    }
  }

  _applyCircleAndHole(roundProgress = 0) {
    const R = CONFIG.arenaRadius * this.arenaScale;
    const halfHole =
      (CONFIG.holeWidth * (1 + roundProgress * 0.55)) / 2;
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
        f.vx += nx * 0.28;
        f.vy += ny * 0.28;
        continue;
      }

      const nx = dx / (dist || 1);
      const ny = dy / (dist || 1);
      f.x = 0.5 + nx * limit;
      f.y = 0.5 + ny * limit;
      const vn = f.vx * nx + f.vy * ny;
      if (vn > 0) {
        f.vx -= 2 * vn * nx;
        f.vy -= 2 * vn * ny;
      }
      // Kick along the rim toward the hole for faster sessions.
      const tangent = Math.sign(angleDiff(this.holeAngle, ang)) || 1;
      f.vx += -ny * tangent * 0.04;
      f.vy += nx * tangent * 0.04;
      f.pulse = 0.3;
    }
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
      this._emit("winner", `${flag.name} is the LAST FLAG STANDING!`);
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
    this._emit(
      "qualify",
      `${flag.name} QUALIFIED for the Final! (Round ${this.round})`
    );

    const slotsFull = this.qualified.length >= CONFIG.finalistSlots;
    this._pendingFinal = slotsFull || this.qualifyingExpired;
    this.phase = "between_rounds";
    this._betweenUntil = performance.now() + CONFIG.betweenRoundMs;
  }

  _startNextQualifyingRound() {
    if (this._pendingFinal) {
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
      this._beginIntermission("final");
      return;
    }

    // Every non-qualified country appears in the round.
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
    this._emit(
      "phase",
      `FINAL — ${this.fighters.length} flags. Last Flag Standing!`
    );
  }

  _emit(type, text) {
    this.events.unshift({ type, text, at: Date.now() });
    if (this.events.length > 40) this.events.length = 40;
  }

  qualifyingRemainingMs(now = performance.now()) {
    if (this.phase === "idle") return CONFIG.qualifyingMs;
    if (this.phase === "intermission" && this.intermissionKind === "open") {
      return CONFIG.qualifyingMs;
    }
    if (this.phase !== "qualifying" && this.phase !== "between_rounds") return 0;
    if (this.qualifyingExpired || !this.qualifyingEndsAt) return 0;
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
      this.phase === "idle" ||
      this.phase === "between_rounds" ||
      (this.phase === "intermission" && this.intermissionKind === "open")
    ) {
      return this.qualified;
    }
    if (this.phase === "intermission" && this.intermissionKind === "final") {
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
        ? CONFIG.holeWidth * (1 + t * 0.55)
        : CONFIG.holeWidth;
    const widthDeg = (width * 180) / Math.PI;
    return {
      rotateDeg: deg,
      widthDeg,
      radiusPct: CONFIG.arenaRadius * this.arenaScale * 100,
    };
  }
}
