/**
 * Round SFX + text-to-speech announcements + ambient bed.
 * In stream mode, also POSTs to /api/announce so PulseAudio→FFmpeg can hear it.
 */

let audioCtx = null;
let lastSpeakAt = 0;
let ambientNodes = null;
let ambientStarted = false;
let streamAudioWatch = null;
/** @type {HTMLAudioElement | null} */
let ncsAudio = null;
/** @type {Map<string, number>} */
const sfxLastAt = new Map();

function isStreamPage() {
  try {
    if (
      typeof document !== "undefined" &&
      document.body?.classList?.contains("stream-mode")
    ) {
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

function ambientTargetGain() {
  return isStreamPage() ? 0.32 : 0.11;
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
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noiseBurst(dur, gain = 0.08, when = 0, filterFreq = 1800) {
  const ac = ctx();
  if (!ac) return;
  const n = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = filterFreq;
  filter.Q.value = 0.8;
  const g = ac.createGain();
  const t0 = ac.currentTime + when;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(ac.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

function sfxAllowed(kind, minGapMs) {
  const now = performance.now();
  const prev = sfxLastAt.get(kind) || 0;
  if (now - prev < minGapMs) return false;
  sfxLastAt.set(kind, now);
  return true;
}

/**
 * Short synthesized stingers — no asset files required.
 * @param {string} kind
 */
export function playSfx(kind) {
  try {
    // Keep AudioContext alive when SFX fire (helps stream Chrome).
    const ac = ctx();
    if (ac?.state === "suspended") ac.resume().catch(() => {});

    if (kind === "qualify" || kind === "opening_win") {
      if (!sfxAllowed(kind, 400)) return;
      tone(523.25, 0.12, "triangle", 0.14, 0);
      tone(659.25, 0.14, "triangle", 0.14, 0.1);
      tone(783.99, 0.22, "triangle", 0.16, 0.2);
    } else if (kind === "winner") {
      if (!sfxAllowed(kind, 800)) return;
      tone(392, 0.15, "sawtooth", 0.1, 0);
      tone(523.25, 0.15, "sawtooth", 0.1, 0.12);
      tone(659.25, 0.18, "sawtooth", 0.12, 0.24);
      tone(783.99, 0.35, "triangle", 0.14, 0.38);
    } else if (kind === "elim" || kind === "fall") {
      if (!sfxAllowed("elim", 90)) return;
      tone(220, 0.16, "square", 0.07, 0);
      tone(140, 0.2, "square", 0.055, 0.1);
      noiseBurst(0.12, 0.05, 0, 900);
    } else if (kind === "hit") {
      if (!sfxAllowed("hit", 55)) return;
      tone(180 + Math.random() * 80, 0.06, "square", 0.05, 0);
      noiseBurst(0.05, 0.04, 0, 1400);
    } else if (kind === "saw") {
      if (!sfxAllowed("saw", 70)) return;
      tone(90, 0.08, "sawtooth", 0.07, 0);
      tone(220 + Math.random() * 120, 0.1, "sawtooth", 0.06, 0.02);
      noiseBurst(0.14, 0.09, 0, 2400);
    } else if (kind === "blackhole") {
      if (!sfxAllowed("blackhole", 120)) return;
      tone(90, 0.28, "sine", 0.1, 0);
      tone(55, 0.35, "triangle", 0.08, 0.05);
      noiseBurst(0.25, 0.06, 0, 400);
    } else if (kind === "catch") {
      if (!sfxAllowed("catch", 80)) return;
      tone(660, 0.05, "square", 0.08, 0);
      tone(220, 0.12, "sawtooth", 0.07, 0.04);
      noiseBurst(0.08, 0.05, 0.02, 1200);
    } else if (kind === "alien") {
      if (!sfxAllowed("alien", 80)) return;
      tone(440, 0.05, "square", 0.06, 0);
      tone(280, 0.1, "sawtooth", 0.07, 0.04);
      tone(160, 0.14, "triangle", 0.05, 0.08);
    } else if (kind === "spawn") {
      if (!sfxAllowed("spawn", 60)) return;
      tone(520, 0.07, "sine", 0.06, 0);
      tone(780, 0.09, "triangle", 0.05, 0.05);
    } else if (kind === "bigflag") {
      if (!sfxAllowed("bigflag", 200)) return;
      tone(330, 0.1, "triangle", 0.09, 0);
      tone(495, 0.12, "triangle", 0.08, 0.08);
      tone(660, 0.18, "sine", 0.07, 0.16);
    } else if (kind === "event") {
      if (!sfxAllowed("event", 500)) return;
      tone(392, 0.1, "square", 0.08, 0);
      tone(523, 0.12, "square", 0.07, 0.1);
      tone(311, 0.18, "sawtooth", 0.06, 0.2);
    } else if (kind === "invasion") {
      if (!sfxAllowed("invasion", 1000)) return;
      tone(110, 0.2, "sawtooth", 0.1, 0);
      tone(146, 0.22, "sawtooth", 0.09, 0.15);
      tone(98, 0.35, "triangle", 0.08, 0.3);
      noiseBurst(0.4, 0.07, 0.1, 600);
    } else {
      if (!sfxAllowed("default", 80)) return;
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
    speak(`${who} wins the round!`);
  }
}

function tearDownAmbient() {
  if (ncsAudio) {
    try {
      ncsAudio.pause();
      ncsAudio.removeAttribute("src");
      ncsAudio.load();
    } catch {
      /* ignore */
    }
    ncsAudio = null;
  }
  if (!ambientNodes) {
    ambientStarted = false;
    return;
  }
  try {
    for (const o of ambientNodes.oscs || []) {
      try {
        o.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      ambientNodes.lfo?.stop();
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  ambientNodes = null;
  ambientStarted = false;
}

/** Prefer NCS bed from go-live (`/api/ambient`); fall back to synth pad. */
function startNcsAmbientAudio() {
  try {
    if (typeof Audio === "undefined") return false;
    if (ncsAudio && !ncsAudio.error && !ncsAudio.paused) {
      ambientStarted = true;
      return true;
    }
    const el = new Audio("/api/ambient");
    el.loop = true;
    el.preload = "auto";
    el.volume = isStreamPage() ? 0.22 : 0.14;
    el.crossOrigin = "anonymous";
    const play = () =>
      el.play().then(() => {
        ncsAudio = el;
        ambientStarted = true;
        ambientNodes = { kind: "ncs", el };
      });
    // Probe: if 404, reject and fall back to synth.
    return play()
      .then(() => true)
      .catch(() => {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        return false;
      });
  } catch {
    return false;
  }
}

/**
 * Looping ambient bed — NCS when `/api/ambient` is available, else synth pad.
 * Rebuilds if a prior start happened while suspended.
 */
export function startAmbientMusic({ force = false } = {}) {
  const ac = ctx();
  if (!ac) return false;

  if (ambientStarted && (ambientNodes || ncsAudio) && !force) {
    if (ncsAudio) {
      ncsAudio.play().catch(() => {});
      return true;
    }
    // Nudge gain — scheduled ramps can be stuck if started while suspended.
    try {
      const now = ac.currentTime;
      const target = ambientTargetGain();
      ambientNodes.master.gain.cancelScheduledValues(now);
      ambientNodes.master.gain.setValueAtTime(
        Math.max(0.0001, ambientNodes.master.gain.value || 0.0001),
        now
      );
      ambientNodes.master.gain.exponentialRampToValueAtTime(target, now + 0.9);
    } catch {
      /* ignore */
    }
    return true;
  }

  if (force) tearDownAmbient();

  // Async NCS try — if it fails, build synth immediately after.
  const ncsTry = startNcsAmbientAudio();
  if (ncsTry && typeof ncsTry.then === "function") {
    ncsTry.then((ok) => {
      if (ok) return;
      startSynthAmbient(ac);
    });
    return true;
  }
  if (ncsTry === true) return true;
  return startSynthAmbient(ac);
}

function startSynthAmbient(ac) {
  ambientStarted = true;
  try {
    const master = ac.createGain();
    master.gain.value = 0.0001;
    master.connect(ac.destination);

    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 780;
    filter.Q.value = 0.65;
    filter.connect(master);

    const stream = isStreamPage();
    const voices = [
      { freq: 110, type: "sine", gain: stream ? 0.11 : 0.05 },
      { freq: 164.81, type: "sine", gain: stream ? 0.08 : 0.035 },
      { freq: 220, type: "triangle", gain: stream ? 0.05 : 0.02 },
      { freq: 329.63, type: "sine", gain: stream ? 0.035 : 0.014 },
      { freq: 82.41, type: "triangle", gain: stream ? 0.04 : 0.016 },
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

    // Soft pink-ish bed via filtered noise buffer loop.
    const noiseLen = Math.floor(ac.sampleRate * 2);
    const nbuf = ac.createBuffer(1, noiseLen, ac.sampleRate);
    const nd = nbuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < noiseLen; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      nd[i] = last * 2.5;
    }
    const noise = ac.createBufferSource();
    noise.buffer = nbuf;
    noise.loop = true;
    const nGain = ac.createGain();
    nGain.gain.value = stream ? 0.03 : 0.012;
    const nFilter = ac.createBiquadFilter();
    nFilter.type = "lowpass";
    nFilter.frequency.value = 320;
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(master);
    noise.start();
    oscs.push(noise);

    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    const now = ac.currentTime;
    const target = ambientTargetGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(target, now + 1.4);

    ambientNodes = { master, filter, oscs, lfo, lfoGain };
    return true;
  } catch (err) {
    ambientStarted = false;
    ambientNodes = null;
    console.warn("[ambient]", err?.message || err);
    return false;
  }
}

export function stopAmbientMusic() {
  if (ncsAudio || ambientNodes?.kind === "ncs") {
    tearDownAmbient();
    return;
  }
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
 */
export async function unlockAudio() {
  const ac = ctx();
  if (!ac) return false;
  const wasSuspended = ac.state === "suspended";
  try {
    if (wasSuspended) await ac.resume();
  } catch {
    /* ignore */
  }
  primeAudioGraph(ac);

  if (ac.state === "running") {
    // Rebuild after a suspend — nodes created while suspended can stay silent.
    // Low gain alone just gets a nudge (don't tear down mid fade-in).
    if (!ambientNodes || wasSuspended) {
      startAmbientMusic({ force: true });
    } else {
      startAmbientMusic({ force: false });
    }
  } else {
    // Still suspended — try a quiet tone + schedule another resume.
    try {
      tone(880, 0.03, "sine", 0.001, 0);
    } catch {
      /* ignore */
    }
    startAmbientMusic({ force: true });
    try {
      await ac.resume();
    } catch {
      /* ignore */
    }
    if (ac.state === "running") startAmbientMusic({ force: true });
  }

  return ac.state === "running";
}

/**
 * Keep Web Audio alive for go-live Chrome (Pulse → FFmpeg).
 */
export function ensureStreamAudio() {
  if (!isStreamPage()) return;
  if (streamAudioWatch) return;

  const tick = () => {
    unlockAudio().catch(() => {});
  };

  tick();
  setTimeout(tick, 200);
  setTimeout(tick, 800);
  setTimeout(tick, 2000);
  setTimeout(tick, 5000);

  streamAudioWatch = setInterval(() => {
    const ac = audioCtx;
    if (!ac || ac.state !== "running") {
      tick();
      return;
    }
    if (!ambientNodes || !ambientStarted) {
      startAmbientMusic({ force: true });
    } else {
      // Keep bed audible if gain collapsed.
      try {
        const g = ambientNodes.master?.gain?.value ?? 0;
        if (g < 0.02) startAmbientMusic({ force: false });
      } catch {
        tick();
      }
    }
  }, 2500);

  const onVis = () => tick();
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("focus", onVis);
  window.addEventListener("pageshow", onVis);
}
