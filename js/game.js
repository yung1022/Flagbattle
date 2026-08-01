import { COUNTRIES, flagUrl } from "./countries.js";

/** @typedef {"idle" | "qualifying" | "finalizing" | "final" | "finished"} Phase */

export const CONFIG = {
  qualifyingMs: 30 * 60 * 1000,
  finalistSlots: 32,
  baseHp: 100,
  qualifyPointsNeeded: 5,
  /** Battles per second during qualifying (scaled by remaining fighters). */
  qualifyBattleRate: 2.4,
  /** Battles per second during final. */
  finalBattleRate: 1.1,
  flagRenderSize: 64,
};

const params = new URLSearchParams(location.search);
if (params.has("demo")) {
  CONFIG.qualifyingMs = Number(params.get("demo")) || 45_000;
  CONFIG.qualifyPointsNeeded = 2;
  CONFIG.qualifyBattleRate = 8;
  CONFIG.finalBattleRate = 3;
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
    this.winner = null;
    this._accum = 0;
    this._raf = 0;
    this._lastTs = 0;
    this.onChange = () => {};
  }

  reset() {
    this.stopLoop();
    this.phase = "idle";
    this.fighters = shuffle(COUNTRIES).map((c, i) => this._makeFighter(c, i));
    this.qualified = [];
    this.eliminated = [];
    this.events = [];
    this.phaseStartedAt = 0;
    this.qualifyingEndsAt = 0;
    this.winner = null;
    this._accum = 0;
    this._emit("reset", "All countries ready. Press Start.");
    this.onChange();
  }

  _makeFighter(country, index) {
    const angle = (index / COUNTRIES.length) * Math.PI * 2;
    const radius = 0.28 + (index % 7) * 0.035;
    return {
      ...country,
      id: country.code,
      hp: CONFIG.baseHp,
      maxHp: CONFIG.baseHp,
      points: 0,
      alive: true,
      qualified: false,
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
      vx: rand(-0.08, 0.08),
      vy: rand(-0.08, 0.08),
      img: flagUrl(country.code, 80),
      pulse: 0,
    };
  }

  start() {
    if (this.phase !== "idle" && this.phase !== "finished") return;
    this.reset();
    this.events = [];
    this.phase = "qualifying";
    this.phaseStartedAt = performance.now();
    this.qualifyingEndsAt = this.phaseStartedAt + CONFIG.qualifyingMs;
    this._emit("phase", "QUALIFYING started — survive & score to reach the Final.");
    this._startLoop();
    this.onChange();
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
    if (this.phase === "qualifying" || this.phase === "final") {
      this._moveFighters(dt);
      this._runBattles(dt);
    }

    if (this.phase === "qualifying" && now >= this.qualifyingEndsAt) {
      this._endQualifying();
    }

    if (this.phase === "final") {
      const standing = this.fighters.filter((f) => f.alive);
      if (standing.length <= 1) {
        this.winner = standing[0] || null;
        this.phase = "finished";
        this.stopLoop();
        this._emit(
          "winner",
          this.winner
            ? `${this.winner.name} is the LAST FLAG STANDING!`
            : "No winner."
        );
      }
    }

    this.onChange();
  }

  _moveFighters(dt) {
    const active = this._activeArenaFighters();
    for (const f of active) {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.x < 0.08 || f.x > 0.92) f.vx *= -1;
      if (f.y < 0.1 || f.y > 0.9) f.vy *= -1;
      f.x = Math.min(0.92, Math.max(0.08, f.x));
      f.y = Math.min(0.9, Math.max(0.1, f.y));
      if (f.pulse > 0) f.pulse = Math.max(0, f.pulse - dt * 3);
      // Mild drift toward center so the ring stays readable.
      f.vx += (0.5 - f.x) * 0.02 * dt;
      f.vy += (0.5 - f.y) * 0.02 * dt;
      const speed = Math.hypot(f.vx, f.vy);
      const max = this.phase === "final" ? 0.22 : 0.16;
      if (speed > max) {
        f.vx = (f.vx / speed) * max;
        f.vy = (f.vy / speed) * max;
      }
    }
  }

  _activeArenaFighters() {
    if (this.phase === "qualifying") {
      return this.fighters.filter((f) => f.alive && !f.qualified);
    }
    return this.fighters.filter((f) => f.alive);
  }

  _runBattles(dt) {
    const pool = this._activeArenaFighters();
    if (pool.length < 2) {
      if (this.phase === "qualifying") this._tryFillRemainingSlots();
      return;
    }

    const rate =
      this.phase === "qualifying"
        ? CONFIG.qualifyBattleRate
        : CONFIG.finalBattleRate;
    // More fighters → slightly more simultaneous clashes.
    const density = Math.min(4, Math.sqrt(pool.length) / 4);
    this._accum += dt * rate * density;

    while (this._accum >= 1) {
      this._accum -= 1;
      this._clash(pool);
      // Refresh pool if someone just left.
      const next = this._activeArenaFighters();
      if (next.length < 2) break;
      pool.length = 0;
      pool.push(...next);
    }
  }

  _clash(pool) {
    if (pool.length < 2) return;
    const a = pool[Math.floor(Math.random() * pool.length)];
    let b = pool[Math.floor(Math.random() * pool.length)];
    let guard = 0;
    while (b === a && guard++ < 8) {
      b = pool[Math.floor(Math.random() * pool.length)];
    }
    if (a === b) return;

    const dmgA = rand(12, 28);
    const dmgB = rand(12, 28);
    // Slight underdog bounce so favorites don't steamroll forever.
    const roll = Math.random();
    if (roll < 0.5) {
      b.hp -= dmgA;
      a.pulse = 1;
      if (b.hp <= 0) this._eliminate(b, a);
      else a.points += 1;
    } else {
      a.hp -= dmgB;
      b.pulse = 1;
      if (a.hp <= 0) this._eliminate(a, b);
      else b.points += 1;
    }

    if (this.phase === "qualifying") {
      for (const f of [a, b]) {
        if (
          f.alive &&
          !f.qualified &&
          f.points >= CONFIG.qualifyPointsNeeded &&
          this.qualified.length < CONFIG.finalistSlots
        ) {
          this._qualify(f);
        }
      }
    }
  }

  _eliminate(loser, winner) {
    if (!loser.alive) return;
    loser.alive = false;
    loser.hp = 0;
    this.eliminated.push(loser);
    if (winner) winner.points += 1;
    this._emit(
      "elim",
      `${loser.name} eliminated${winner ? ` by ${winner.name}` : ""}`
    );

    if (this.phase === "qualifying") {
      this._tryFillRemainingSlots();
    }
  }

  _qualify(f, { fromEnd = false } = {}) {
    if (f.qualified) return;
    f.qualified = true;
    f.alive = true;
    f.hp = CONFIG.baseHp;
    this.qualified.push(f);
    this._emit("qualify", `${f.name} QUALIFIED for the Final!`);
    if (!fromEnd && this.qualified.length >= CONFIG.finalistSlots) {
      this._endQualifying(true);
    }
  }

  _tryFillRemainingSlots() {
    // If arena empties before slots fill, promote top remaining by points.
    const fighting = this.fighters.filter((f) => f.alive && !f.qualified);
    if (fighting.length === 0 && this.qualified.length < CONFIG.finalistSlots) {
      this._endQualifying(true);
    }
  }

  _endQualifying(early = false) {
    if (this.phase !== "qualifying") return;
    this.phase = "finalizing";

    // Fill remaining slots from survivors with most points, then anyone left.
    const contenders = this.fighters
      .filter((f) => f.alive && !f.qualified)
      .sort((a, b) => b.points - a.points || b.hp - a.hp);

    for (const f of contenders) {
      if (this.qualified.length >= CONFIG.finalistSlots) {
        f.alive = false;
        f.hp = 0;
        this.eliminated.push(f);
      } else {
        this._qualify(f, { fromEnd: true });
      }
    }

    // Anyone still not qualified is out.
    for (const f of this.fighters) {
      if (!f.qualified) {
        f.alive = false;
        f.hp = 0;
      }
    }

    this.phase = "final";
    this.phaseStartedAt = performance.now();
    this.fighters = this.qualified.map((f, i) => {
      const angle = (i / Math.max(1, this.qualified.length)) * Math.PI * 2;
      const radius = 0.22 + (i % 5) * 0.04;
      return {
        ...f,
        alive: true,
        hp: CONFIG.baseHp,
        maxHp: CONFIG.baseHp,
        points: 0,
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.5 + Math.sin(angle) * radius,
        vx: rand(-0.12, 0.12),
        vy: rand(-0.12, 0.12),
        pulse: 0,
      };
    });
    this.qualified = [...this.fighters];
    this._emit(
      "phase",
      early
        ? `FINAL — ${this.fighters.length} flags. Last Flag Standing!`
        : `Qualifying time up! FINAL — ${this.fighters.length} flags.`
    );
    this.onChange();
  }

  _emit(type, text) {
    this.events.unshift({
      type,
      text,
      at: Date.now(),
    });
    if (this.events.length > 40) this.events.length = 40;
  }

  qualifyingRemainingMs(now = performance.now()) {
    if (this.phase !== "qualifying") return 0;
    return Math.max(0, this.qualifyingEndsAt - now);
  }

  standing() {
    if (this.phase === "qualifying") {
      return this.fighters.filter((f) => f.alive && !f.qualified);
    }
    return this.fighters.filter((f) => f.alive);
  }

  boardFlags() {
    if (this.phase === "qualifying" || this.phase === "idle") {
      return this.qualified;
    }
    // Final / finished: flags still standing (winner alone at end).
    return this.fighters.filter((f) => f.alive);
  }
}
