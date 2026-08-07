/**
 * Round SFX + text-to-speech announcements.
 * In stream mode, also POSTs to /api/announce so PulseAudio→FFmpeg can hear it.
 * Includes a quiet looping ambient pad for livestream atmosphere.
 */

let audioCtx = null;
let lastSpeakAt = 0;
let ambientNodes = null;
let ambientStarted = false;
let streamAudioWatch = null;

function isStreamPage() {
  try {
    if (typeof document !== "undefined" && document.body?.classList?.contains("stream-mode")) {
      return true;
    }
    if (typeof location !== "undefined") {
      return new URLSearchParams(location.search).has("stream");
    }
  } catch {
    /* ignore */
  }
  return false;
}

function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** Play a near-silent buffer — helps kick AudioContext out of suspended. */
function primeAudioGraph(ac) {
  if (!ac) return;
  try {
    const buf = ac.createBuffer(1, 1, ac.sampleRate || 44100);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start(0);
  } catch {
    /* ignore */
  }
}

function tone(freq, dur, type = "sine", gain = 0.12, when = 0) {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime + when;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Short synthesized stingers — no asset files required. */
export function playSfx(kind) {
  try {
    if (kind === "qualify") {
      tone(523.25, 0.12, "triangle", 0.14, 0);
      tone(659.25, 0.14, "triangle", 0.14, 0.1);
      tone(783.99, 0.22, "triangle", 0.16, 0.2);
    } else if (kind === "winner") {
      tone(392, 0.15, "sawtooth", 0.1, 0);
      tone(523.25, 0.15, "sawtooth", 0.1, 0.12);
      tone(659.25, 0.18, "sawtooth", 0.12, 0.24);
      tone(783.99, 0.35, "triangle", 0.14, 0.38);
    } else if (kind === "elim") {
      tone(220, 0.18, "square", 0.06, 0);
      tone(160, 0.22, "square", 0.05, 0.12);
    } else {
      tone(440, 0.1, "sine", 0.08, 0);
    }
  } catch {
    /* ignore */
  }
}

export function speak(text, { force = false } = {}) {
  const line = String(text || "").trim();
  if (!line) return;
  const now = Date.now();
  if (!force && now - lastSpeakAt < 700) return;
  lastSpeakAt = now;

  // Browser TTS (local preview / when voices exist).
  try {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(line);
      u.rate = 1.05;
      u.pitch = 1;
      u.volume = 1;
      const voices = window.speechSynthesis.getVoices?.() || [];
      const en = voices.find((v) => /en[-_]/i.test(v.lang)) || voices[0];
      if (en) u.voice = en;
      window.speechSynthesis.speak(u);
    }
  } catch {
    /* ignore */
  }

  // Server-side espeak → PulseAudio (picked up by FFmpeg on go-live).
  if (typeof fetch === "function") {
    fetch("/api/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line }),
    }).catch(() => {});
  }
}

export function announceRoundWinner(name, { champion = false } = {}) {
  const who = String(name || "Unknown").trim();
  if (champion) {
    playSfx("winner");
    speak(`${who} is the last flag standing!`);
  } else {
    playSfx("qualify");
    speak(`${who} wins the round and qualifies for the final!`);
  }
}

/**
 * Quiet looping ambient pad (Web Audio) — calm bed under the battle.
 * Safe to call repeatedly; starts once after audio unlock.
 * Louder on ?stream=1 so Pulse→FFmpeg→YouTube still hears it after capture.
 */
export function startAmbientMusic() {
  const ac = ctx();
  if (!ac || ambientStarted) return;
  ambientStarted = true;

  try {
    const master = ac.createGain();
    master.gain.value = 0.0001;
    master.connect(ac.destination);

    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 720;
    filter.Q.value = 0.7;
    filter.connect(master);

    // Soft detuned triad — Am-ish calm bed.
    const stream = isStreamPage();
    const voices = [
      { freq: 110, type: "sine", gain: stream ? 0.09 : 0.045 },
      { freq: 164.81, type: "sine", gain: stream ? 0.065 : 0.032 },
      { freq: 220, type: "triangle", gain: stream ? 0.04 : 0.018 },
      { freq: 329.63, type: "sine", gain: stream ? 0.028 : 0.012 },
    ];

    const oscs = [];
    for (const v of voices) {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = v.type;
      osc.frequency.value = v.freq;
      g.gain.value = v.gain;
      osc.connect(g);
      g.connect(filter);
      osc.start();
      oscs.push(osc);
    }

    // Slow filter + volume breathe.
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    const now = ac.currentTime;
    // Stream capture (Pulse mix / AAC) loses headroom — keep bed audible.
    const target = stream ? 0.22 : 0.085;
    master.gain.exponentialRampToValueAtTime(target, now + 1.2);

    ambientNodes = { master, filter, oscs, lfo, lfoGain };
  } catch (err) {
    ambientStarted = false;
    console.warn("[ambient]", err?.message || err);
  }
}

export function stopAmbientMusic() {
  if (!ambientNodes) return;
  try {
    const ac = ctx();
    const { master, oscs, lfo } = ambientNodes;
    const now = ac?.currentTime || 0;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    setTimeout(() => {
      try {
        for (const o of oscs || []) o.stop();
        lfo?.stop();
      } catch {
        /* ignore */
      }
      ambientNodes = null;
      ambientStarted = false;
    }, 1400);
  } catch {
    ambientNodes = null;
    ambientStarted = false;
  }
}

/**
 * Resume AudioContext + start ambient. Returns whether context is running.
 * Safe to call often (stream Chrome has no real user gesture).
 */
export async function unlockAudio() {
  const ac = ctx();
  if (!ac) return false;
  try {
    if (ac.state === "suspended") await ac.resume();
  } catch {
    /* ignore */
  }
  primeAudioGraph(ac);
  // Tiny blip so autoplay policies allow later SFX / music.
  try {
    tone(880, 0.03, "sine", 0.001, 0);
  } catch {
    /* ignore */
  }
  startAmbientMusic();
  try {
    if (ac.state === "suspended") await ac.resume();
  } catch {
    /* ignore */
  }
  return ac.state === "running";
}

/**
 * Keep Web Audio alive for go-live Chrome (Pulse → FFmpeg).
 * Retries resume until running, then light keep-alive if it suspends again.
 */
export function ensureStreamAudio() {
  if (!isStreamPage()) return;
  if (streamAudioWatch) return;

  const tick = () => {
    unlockAudio().catch(() => {});
  };

  tick();
  // Early bursts — Chrome often needs a few resume attempts after load.
  setTimeout(tick, 200);
  setTimeout(tick, 800);
  setTimeout(tick, 2000);

  streamAudioWatch = setInterval(() => {
    const ac = audioCtx;
    if (!ac || ac.state !== "running" || !ambientStarted) {
      tick();
    }
  }, 2000);

  const onVis = () => tick();
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("focus", onVis);
  window.addEventListener("pageshow", onVis);
}
