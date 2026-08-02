/**
 * Mobile Go Live control center.
 * - Easy: YouTube app screen share
 * - Cloud: trigger GitHub Actions encoder
 * - Highlights: Final / Season Top 10 Shorts + upload to YouTube
 * - Setup: Google device OAuth + push repo secrets (phone-only)
 */

import sodiumModule from "https://esm.sh/libsodium-wrappers@0.7.15";
import {
  generateHighlightShort,
  generateSeasonHighlightShort,
  downloadBlob,
} from "../js/highlight-short.js";
import {
  refreshAccessToken,
  uploadYoutubeShort,
} from "../js/youtube-upload.js";
import { fetchStreamsFromApi } from "../js/store.js";
import { resolveApiBase } from "../js/public.js";

const sodium = sodiumModule;

const STORAGE_KEY = "flagbattle.mobile.v1";

const $ = (id) => document.getElementById(id);
const state = load();

const ytScope = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.upload",
].join(" ");

let hlStreams = [];
let hlBlob = null;
let hlMime = "video/webm";

init();

function init() {
  bindTabs();
  fillForm();
  $("btn-save-cloud").addEventListener("click", saveCloudFields);
  $("btn-save-google").addEventListener("click", saveGoogleFields);
  $("btn-go-live").addEventListener("click", goLive);
  $("btn-device-auth").addEventListener("click", startDeviceAuth);
  $("btn-push-secrets").addEventListener("click", pushSecrets);
  $("btn-copy-secrets").addEventListener("click", copySecrets);
  $("btn-copy-arena").addEventListener("click", copyArenaLink);
  $("btn-hl-generate").addEventListener("click", generateHighlight);
  $("btn-hl-download").addEventListener("click", downloadHighlight);
  $("btn-hl-upload").addEventListener("click", uploadHighlight);
  $("hl-stream").addEventListener("change", syncHighlightTitle);
  const hlFormat = $("hl-format");
  if (hlFormat) {
    hlFormat.addEventListener("change", onHighlightFormatChange);
    hlFormat.addEventListener("input", onHighlightFormatChange);
  }
  $("hl-title").addEventListener("input", () => {
    $("hl-title").dataset.auto = "0";
  });
  onHighlightFormatChange();

  // Default repo guess from path when hosted on GitHub Pages.
  if (!$("gh-repo").value) {
    const host = location.hostname;
    if (host.endsWith("github.io")) {
      const owner = host.replace(".github.io", "");
      const parts = location.pathname.split("/").filter(Boolean);
      const repo = parts[0] || "Flagbattle";
      $("gh-repo").value = `${owner}/${repo}`;
    }
  }

  // Fix relative arena link when served from /control/
  const arena = $("btn-open-arena");
  arena.href = new URL("../?stream=1&autostart=1&mobile=1", location.href).href;

  loadHighlightStreams();
}

function bindTabs() {
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.getAttribute("data-tab");
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t.getAttribute("data-tab") === name);
      });
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.toggle("active", p.id === `panel-${name}`);
      });
    });
  });
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function fillForm() {
  $("gh-repo").value = state.ghRepo || "";
  $("gh-token").value = state.ghToken || "";
  $("yt-privacy").value = state.privacy || "unlisted";
  $("demo-seconds").value = state.demoSeconds ?? "120";
  $("duration-min").value = state.durationMin ?? "35";
  $("g-client-id").value = state.clientId || "";
  $("g-client-secret").value = state.clientSecret || "";
  $("g-refresh").value = state.refreshToken || "";
}

function saveCloudFields() {
  state.ghRepo = $("gh-repo").value.trim();
  state.ghToken = $("gh-token").value.trim();
  state.privacy = $("yt-privacy").value;
  state.demoSeconds = $("demo-seconds").value.trim();
  state.durationMin = $("duration-min").value.trim();
  persist();
  log("cloud-log", "Saved cloud settings on this phone.");
}

function saveGoogleFields() {
  state.clientId = $("g-client-id").value.trim();
  state.clientSecret = $("g-client-secret").value.trim();
  state.refreshToken = $("g-refresh").value.trim();
  persist();
  log("setup-log", "Saved Google fields on this phone (not uploaded yet).");
}

async function copyArenaLink() {
  const url = new URL("../?stream=1&autostart=1&mobile=1", location.href).href;
  await navigator.clipboard.writeText(url);
  $("btn-copy-arena").textContent = "Copied";
  setTimeout(() => {
    $("btn-copy-arena").textContent = "Copy arena link";
  }, 1200);
}

function log(id, msg) {
  const el = $(id);
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.textContent = el.textContent ? `${el.textContent}\n${line}` : line;
  el.scrollTop = el.scrollHeight;
}

/* ——— Google device OAuth (works fully on one phone) ——— */

async function startDeviceAuth() {
  saveGoogleFields();
  const clientId = state.clientId;
  const clientSecret = state.clientSecret;
  if (!clientId || !clientSecret) {
    log("setup-log", "Client ID and Client Secret are required.");
    return;
  }

  $("btn-device-auth").disabled = true;
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      scope: ytScope,
    });
    const res = await fetch("https://oauth2.googleapis.com/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error_description || data.error || res.statusText);
    }

    $("device-box").hidden = false;
    $("user-code").textContent = data.user_code;
    $("verify-link").href = data.verification_url || "https://www.google.com/device";
    $("device-status").textContent = "Waiting for approval…";
    log("setup-log", `Device code ready. Open google.com/device and enter ${data.user_code}`);

    const tokens = await pollDeviceToken({
      clientId,
      clientSecret,
      deviceCode: data.device_code,
      intervalSec: data.interval || 5,
      expiresIn: data.expires_in || 1800,
    });

    state.refreshToken = tokens.refresh_token || state.refreshToken;
    state.accessToken = tokens.access_token;
    $("g-refresh").value = state.refreshToken || "";
    persist();
    $("device-status").textContent = "Authorized ✓";
    log("setup-log", "Got refresh token. Next: Push secrets to GitHub.");
  } catch (err) {
    log("setup-log", `Auth failed: ${err.message || err}`);
    $("device-status").textContent = "Failed";
  } finally {
    $("btn-device-auth").disabled = false;
  }
}

async function pollDeviceToken({
  clientId,
  clientSecret,
  deviceCode,
  intervalSec,
  expiresIn,
}) {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = Math.max(3, intervalSec) * 1000;

  while (Date.now() < deadline) {
    await sleep(wait);
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (res.ok && data.access_token) return data;
    if (data.error === "authorization_pending") {
      $("device-status").textContent = "Waiting for approval…";
      continue;
    }
    if (data.error === "slow_down") {
      wait += 2000;
      continue;
    }
    throw new Error(data.error_description || data.error || "token poll failed");
  }
  throw new Error("Device login timed out");
}

/* ——— GitHub secrets + workflow ——— */

async function pushSecrets() {
  saveGoogleFields();
  saveCloudFields();
  const repo = state.ghRepo;
  const token = state.ghToken;
  if (!repo || !token) {
    log("setup-log", "Set GitHub repo + PAT in the Cloud tab first.");
    return;
  }
  if (!state.clientId || !state.clientSecret || !state.refreshToken) {
    log("setup-log", "Need Client ID, Secret, and Refresh token.");
    return;
  }

  try {
    await sodium.ready;
    const [owner, name] = splitRepo(repo);
    const keyRes = await gh(
      token,
      `https://api.github.com/repos/${owner}/${name}/actions/secrets/public-key`
    );
    const { key, key_id } = keyRes;

    const secrets = {
      GOOGLE_CLIENT_ID: state.clientId,
      GOOGLE_CLIENT_SECRET: state.clientSecret,
      GOOGLE_REFRESH_TOKEN: state.refreshToken,
    };

    for (const [secretName, value] of Object.entries(secrets)) {
      const encrypted = encryptSecret(value, key);
      await gh(
        token,
        `https://api.github.com/repos/${owner}/${name}/actions/secrets/${secretName}`,
        {
          method: "PUT",
          body: JSON.stringify({
            encrypted_value: encrypted,
            key_id,
          }),
        }
      );
      log("setup-log", `Secret ${secretName} updated`);
    }
    log("setup-log", "All YouTube secrets pushed. Open Cloud tab → Go live now.");
  } catch (err) {
    log("setup-log", `Push failed: ${err.message || err}`);
  }
}

function encryptSecret(secret, publicKeyB64) {
  const keyBytes = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const msgBytes = sodium.from_string(secret);
  const sealed = sodium.crypto_box_seal(msgBytes, keyBytes);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function goLive() {
  saveCloudFields();
  const repo = state.ghRepo;
  const token = state.ghToken;
  if (!repo || !token) {
    log("cloud-log", "GitHub repo and PAT are required.");
    return;
  }

  $("btn-go-live").disabled = true;
  try {
    const [owner, name] = splitRepo(repo);
    // Resolve workflow file id/path
    const workflows = await gh(
      token,
      `https://api.github.com/repos/${owner}/${name}/actions/workflows`
    );
    const wf = (workflows.workflows || []).find((w) =>
      String(w.path || "").endsWith("go-live.yml")
    );
    if (!wf) throw new Error("Workflow go-live.yml not found on default branch");

    await gh(
      token,
      `https://api.github.com/repos/${owner}/${name}/actions/workflows/${wf.id}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: "main",
          inputs: {
            demo_seconds: state.demoSeconds || "",
            privacy: state.privacy || "unlisted",
            duration_minutes: state.durationMin || "35",
          },
        }),
      }
    );

    log("cloud-log", "Go-live workflow started.");
    log(
      "cloud-log",
      `Track it: https://github.com/${owner}/${name}/actions`
    );

    // Try to surface the newest run URL after a short wait.
    await sleep(3000);
    const runs = await gh(
      token,
      `https://api.github.com/repos/${owner}/${name}/actions/workflows/${wf.id}/runs?per_page=1`
    );
    const run = runs.workflow_runs?.[0];
    if (run?.html_url) log("cloud-log", `Latest run: ${run.html_url}`);
  } catch (err) {
    log("cloud-log", `Go live failed: ${err.message || err}`);
  } finally {
    $("btn-go-live").disabled = false;
  }
}

async function copySecrets() {
  saveGoogleFields();
  const text = [
    `GOOGLE_CLIENT_ID=${state.clientId || ""}`,
    `GOOGLE_CLIENT_SECRET=${state.clientSecret || ""}`,
    `GOOGLE_REFRESH_TOKEN=${state.refreshToken || ""}`,
  ].join("\n");
  await navigator.clipboard.writeText(text);
  log("setup-log", "Secrets copied. Paste into GitHub → Settings → Secrets → Actions.");
}

async function gh(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || JSON.stringify(data) || res.statusText);
  }
  return data;
}

function splitRepo(repo) {
  const clean = repo.replace(/^https?:\/\/github.com\//, "").replace(/\.git$/, "");
  const [owner, name] = clean.split("/");
  if (!owner || !name) throw new Error("Repo must look like owner/name");
  return [owner, name];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ——— Highlight Short ——— */

async function loadHighlightStreams() {
  try {
    await resolveApiBase();
    let streams = (await fetchStreamsFromApi()) || [];
    // Also try relative Pages data when API missing.
    if (!streams.length) {
      try {
        const res = await fetch("../data/rankings.json", { cache: "no-store" });
        if (res.ok) streams = await res.json();
      } catch {
        /* ignore */
      }
    }
    hlStreams = (streams || [])
      .filter((s) => s.final?.ranking?.length)
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));

    const sel = $("hl-stream");
    sel.innerHTML = "";
    if (!hlStreams.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No finished Finals yet";
      sel.appendChild(opt);
      log("hl-log", "No finished Finals in rankings data.");
      return;
    }
    for (const s of hlStreams) {
      const opt = document.createElement("option");
      opt.value = s.id;
      const when = s.startedAt
        ? new Date(s.startedAt).toLocaleString()
        : s.id;
      const winner = s.final?.winner?.name || s.winner?.name || "Champion";
      opt.textContent = `${when} · ${winner} · ${s.final.ranking.length} finalists`;
      sel.appendChild(opt);
    }
    syncHighlightTitle();
    log("hl-log", `Loaded ${hlStreams.length} finished Final(s).`);
  } catch (err) {
    log("hl-log", `Could not load streams: ${err.message || err}`);
  }
}

function selectedHighlightStream() {
  const id = $("hl-stream").value;
  return hlStreams.find((s) => s.id === id) || null;
}

function highlightFormat() {
  const el = $("hl-format");
  return el && el.value === "season" ? "season" : "final";
}

function clearHighlightPreview() {
  hlBlob = null;
  hlMime = "video/webm";
  const vid = $("hl-preview");
  if (vid) {
    try {
      vid.pause();
    } catch {
      /* ignore */
    }
    vid.removeAttribute("src");
    vid.load();
    vid.hidden = true;
  }
  const dl = $("btn-hl-download");
  const up = $("btn-hl-upload");
  if (dl) dl.disabled = true;
  if (up) up.disabled = true;
}

function onHighlightFormatChange() {
  const season = highlightFormat() === "season";
  const field = $("hl-stream-field");
  if (field) {
    field.hidden = season;
    field.style.display = season ? "none" : "";
  }
  const hint = $("hl-format-hint");
  if (hint) {
    hint.textContent = season
      ? "Season: Generate to reveal points Top 10 with ↑/↓ and anthems."
      : "Final: pick a finished stream below, then Generate.";
  }
  $("hl-title").dataset.auto = "1";
  syncHighlightTitle();
  clearHighlightPreview();
  log(
    "hl-log",
    season
      ? "Format: Season Top 10 — tap Generate Short."
      : "Format: Final Top 10 — pick a stream, then Generate Short."
  );
}

function syncHighlightTitle() {
  if ($("hl-title").value && $("hl-title").dataset.auto !== "1") return;
  if (highlightFormat() === "season") {
    $("hl-title").value = "FLAG BATTLE Season Top 10 · Rank changes #Shorts";
    $("hl-title").dataset.auto = "1";
    return;
  }
  const s = selectedHighlightStream();
  if (!s) {
    $("hl-title").value = "FLAG BATTLE Final Top 10 #Shorts";
    $("hl-title").dataset.auto = "1";
    return;
  }
  const winner = s.final?.winner?.name || s.winner?.name || "Champion";
  const when = s.startedAt
    ? new Date(s.startedAt).toLocaleDateString()
    : "Final";
  $("hl-title").value = `FLAG BATTLE Final Top 10 · ${winner} · ${when} #Shorts`;
  $("hl-title").dataset.auto = "1";
}

async function generateHighlight() {
  const format = highlightFormat();
  const stream = selectedHighlightStream();
  if (format === "final" && !stream) {
    log("hl-log", "Pick a finished Final first.");
    return;
  }
  if (format === "season" && !hlStreams.length) {
    log("hl-log", "No season history loaded yet.");
    return;
  }
  $("btn-hl-generate").disabled = true;
  $("btn-hl-download").disabled = true;
  $("btn-hl-upload").disabled = true;
  hlBlob = null;
  try {
    log(
      "hl-log",
      format === "season"
        ? "Generating Season Top 10 Short (Wikimedia anthems + ↑/↓)…"
        : "Generating Final Top 10 Short (Wikimedia anthems)…"
    );

    const onProgress = ({ phase, progress }) => {
      $("btn-hl-generate").textContent = `${phase} ${Math.round(progress * 100)}%`;
    };
    const result =
      format === "season"
        ? await generateSeasonHighlightShort(hlStreams, { onProgress })
        : await generateHighlightShort(stream, { onProgress });
    if (highlightFormat() !== format) {
      log("hl-log", "Format changed during generate — discarded. Generate again.");
      return;
    }
    hlBlob = result.blob;
    hlMime = result.mimeType || hlBlob.type;
    const url = URL.createObjectURL(hlBlob);
    const vid = $("hl-preview");
    vid.src = url;
    vid.hidden = false;
    vid.muted = false;
    $("btn-hl-download").disabled = false;
    $("btn-hl-upload").disabled = false;
    log(
      "hl-log",
      `Ready · ${(hlBlob.size / 1024 / 1024).toFixed(1)} MB · ${result.durationSec.toFixed(0)}s · ${hlMime}`
    );
  } catch (err) {
    log("hl-log", `Generate failed: ${err.message || err}`);
  } finally {
    $("btn-hl-generate").disabled = false;
    $("btn-hl-generate").textContent = "Generate Short";
  }
}

function downloadHighlight() {
  if (!hlBlob) return;
  const format = highlightFormat();
  const stream = selectedHighlightStream();
  const name =
    format === "season"
      ? "flag-battle-season-top10.webm"
      : `flag-battle-final-top10-${stream?.id || "final"}.webm`;
  downloadBlob(hlBlob, name);
  log("hl-log", `Download started: ${name}`);
}

async function uploadHighlight() {
  saveGoogleFields();
  if (!hlBlob) {
    log("hl-log", "Generate a Short first.");
    return;
  }
  if (!state.clientId || !state.clientSecret || !state.refreshToken) {
    log("hl-log", "Setup tab: authorize Google (refresh token) first.");
    return;
  }
  $("btn-hl-upload").disabled = true;
  try {
    log("hl-log", "Refreshing YouTube access token…");
    const accessToken = await refreshAccessToken({
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      refreshToken: state.refreshToken,
    });
    const format = highlightFormat();
    const stream = selectedHighlightStream();
    const winner = stream?.final?.winner?.name || "Champion";
    const title =
      $("hl-title").value.trim() ||
      (format === "season"
        ? "FLAG BATTLE Season Top 10 #Shorts"
        : `FLAG BATTLE Final Top 10 · ${winner} #Shorts`);
    const description =
      format === "season"
        ? [
            "FLAG BATTLE — Season Top 10 points ranking with rank gains and losses.",
            "Each country gets 5 seconds of its national anthem.",
            "",
            "Rankings: https://yung1022.github.io/Flagbattle/rankings.html",
            "#Shorts #FlagBattle #LastFlagStanding #Geography",
          ].join("\n")
        : [
            "FLAG BATTLE — Final Top 10 with national anthems.",
            `Champion: ${winner}`,
            stream?.startedAt
              ? `Battle: ${new Date(stream.startedAt).toLocaleString()}`
              : "",
            "",
            "Rankings: https://yung1022.github.io/Flagbattle/rankings.html",
            "#Shorts #FlagBattle #LastFlagStanding #Geography",
          ]
            .filter(Boolean)
            .join("\n");

    log("hl-log", "Uploading to YouTube…");
    const uploaded = await uploadYoutubeShort({
      accessToken,
      blob: hlBlob,
      title,
      description,
      privacyStatus: $("hl-privacy").value || "public",
    });
    log("hl-log", `Uploaded ✓ ${uploaded.watchUrl}`);
    log("hl-log", `Shorts URL: ${uploaded.shortsUrl}`);
  } catch (err) {
    log("hl-log", `Upload failed: ${err.message || err}`);
    log(
      "hl-log",
      "If scope errors: Setup → Start device login again (upload scope), then retry."
    );
  } finally {
    $("btn-hl-upload").disabled = false;
  }
}
