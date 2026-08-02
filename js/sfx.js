/**
 * Round SFX + text-to-speech announcements.
 * In stream mode, also POSTs to /api/announce so PulseAudio→FFmpeg can hear it.
 */

let audioCtx = null;
let lastSpeakAt = 0;

function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
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

export function unlockAudio() {
  const ac = ctx();
  if (!ac) return;
  // Prime with a tiny blip so autoplay policies allow later SFX.
  try {
    tone(880, 0.03, "sine", 0.001, 0);
  } catch {
    /* ignore */
  }
}
