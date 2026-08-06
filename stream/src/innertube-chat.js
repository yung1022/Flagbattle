/**
 * Read YouTube live chat via Innertube (same path the website uses).
 * Does NOT use YouTube Data API quota.
 *
 * Flow:
 *  1) Load /live_chat?v=… popout HTML → apiKey, clientVersion, continuation
 *  2) Prefer the "Live chat" (unfiltered) continuation when present
 *  3) Poll youtubei/v1/live_chat/get_live_chat with that continuation
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * @param {string} videoId broadcast / video id
 * @returns {Promise<{
 *   videoId: string,
 *   apiKey: string,
 *   clientVersion: string,
 *   continuation: string,
 *   ownerChannelId: string|null,
 * }>}
 */
export async function openInnertubeLiveChat(videoId) {
  const id = String(videoId || "").trim();
  if (!id) throw new Error("videoId required");

  const url = `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(id)}`;
  const html = await fetchText(url);
  if (/login|Sign in|consent/i.test(html) && !/"INNERTUBE_API_KEY"/.test(html)) {
    throw new Error("live_chat page blocked (consent/login) — try again later");
  }

  const apiKey = match1(html, /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const clientVersion =
    match1(html, /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/) ||
    match1(html, /"clientVersion"\s*:\s*"([\d.]+)"/);
  if (!apiKey || !clientVersion) {
    throw new Error("Innertube key/version not found on live_chat page");
  }

  let continuation = pickLiveChatContinuation(html);
  if (!continuation) {
    continuation = match1(html, /"continuation"\s*:\s*"([^"]+)"/);
  }
  if (!continuation) {
    throw new Error("live chat continuation not found (stream may not be live yet)");
  }

  const ownerChannelId =
    match1(html, /"channelId"\s*:\s*"(UC[^"]+)"/) ||
    match1(html, /"externalChannelId"\s*:\s*"(UC[^"]+)"/) ||
    null;

  return {
    videoId: id,
    apiKey,
    clientVersion,
    continuation,
    ownerChannelId,
  };
}

/**
 * One Innertube poll.
 * @param {{ apiKey: string, clientVersion: string, continuation: string }} session
 * @returns {Promise<{
 *   messages: Array<{
 *     id: string,
 *     text: string,
 *     authorName: string,
 *     channelId: string,
 *     isOwner: boolean,
 *     isModerator: boolean,
 *   }>,
 *   continuation: string,
 *   timeoutMs: number,
 *   ended: boolean,
 * }>}
 */
export async function pollInnertubeLiveChat(session) {
  const apiKey = session.apiKey;
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false&key=${encodeURIComponent(apiKey)}`;
  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: session.clientVersion,
        hl: "en",
        gl: "US",
      },
    },
    continuation: session.continuation,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.youtube.com",
      Referer: `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(session.videoId || "")}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`get_live_chat HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  const data = await res.json();
  const liveChat = data?.continuationContents?.liveChatContinuation;
  if (!liveChat) {
    // Stream ended or continuation expired.
    return {
      messages: [],
      continuation: session.continuation,
      timeoutMs: 5000,
      ended: true,
    };
  }

  const messages = [];
  for (const action of liveChat.actions || []) {
    const item = parseAction(action);
    if (item) messages.push(item);
  }

  const { continuation, timeoutMs } = readContinuation(liveChat.continuations);
  return {
    messages,
    continuation: continuation || session.continuation,
    timeoutMs: clamp(timeoutMs || 5000, 1000, 15000),
    ended: false,
  };
}

/** Prefer unfiltered "Live chat" continuation over "Top chat". */
function pickLiveChatContinuation(html) {
  // sortFilterSubMenuRenderer options: Title "Live chat" / "Top chat"
  const liveLabeled = html.match(
    /"title"\s*:\s*\{\s*"simpleText"\s*:\s*"Live chat"\s*\}[\s\S]{0,400}?"continuation"\s*:\s*"([^"]+)"/
  );
  if (liveLabeled?.[1]) return liveLabeled[1];

  // Sometimes title is nested runs
  const liveRuns = html.match(
    /"text"\s*:\s*"Live chat"[\s\S]{0,500}?"continuation"\s*:\s*"([^"]+)"/
  );
  if (liveRuns?.[1]) return liveRuns[1];

  // Fallback: first reloadContinuationData on the page (often Top chat)
  const reload = html.match(
    /"reloadContinuationData"\s*:\s*\{\s*"continuation"\s*:\s*"([^"]+)"/
  );
  return reload?.[1] || null;
}

function readContinuation(continuations) {
  const c0 = Array.isArray(continuations) ? continuations[0] : null;
  if (!c0) return { continuation: "", timeoutMs: 5000 };
  if (c0.invalidationContinuationData) {
    return {
      continuation: c0.invalidationContinuationData.continuation || "",
      timeoutMs: Number(c0.invalidationContinuationData.timeoutMs) || 5000,
    };
  }
  if (c0.timedContinuationData) {
    return {
      continuation: c0.timedContinuationData.continuation || "",
      timeoutMs: Number(c0.timedContinuationData.timeoutMs) || 5000,
    };
  }
  if (c0.reloadContinuationData) {
    return {
      continuation: c0.reloadContinuationData.continuation || "",
      timeoutMs: 5000,
    };
  }
  return { continuation: "", timeoutMs: 5000 };
}

function parseAction(action) {
  const renderer =
    action?.addChatItemAction?.item?.liveChatTextMessageRenderer || null;
  if (!renderer) return null;

  const id = String(renderer.id || "");
  if (!id) return null;

  const text = runsToText(renderer.message?.runs).trim();
  if (!text) return null;

  let isOwner = false;
  let isModerator = false;
  for (const badge of renderer.authorBadges || []) {
    const icon = badge?.liveChatAuthorBadgeRenderer?.icon?.iconType;
    if (icon === "OWNER") isOwner = true;
    if (icon === "MODERATOR") isModerator = true;
  }

  return {
    id,
    text,
    authorName: String(renderer.authorName?.simpleText || "").trim() || "Viewer",
    channelId: String(renderer.authorExternalChannelId || ""),
    isOwner,
    isModerator,
  };
}

function runsToText(runs) {
  if (!Array.isArray(runs)) return "";
  return runs
    .map((r) => {
      if (typeof r?.text === "string") return r.text;
      if (r?.emoji?.emojiId) return r.emoji.shortcuts?.[0] || "";
      return "";
    })
    .join("");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

function match1(text, re) {
  const m = String(text || "").match(re);
  return m?.[1] || null;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
