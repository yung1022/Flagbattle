/**
 * YouTube live chat votes → poll API + optional chat replies.
 * Accepts "!vote Japan", "!vote jp", or a bare country name/code message.
 *
 * Default chat source: Innertube (website live_chat) — zero Data API quota.
 * Set CHAT_VOTE_SOURCE=api to use liveChatMessages.list (costs quota).
 *
 * Never counts the broadcaster / bot account — their reply messages (and the
 * host's own chat) used to re-parse as votes and loop.
 */
import { parseVoteMessage } from "../../js/vote-message.js";
import {
  openInnertubeLiveChat,
  pollInnertubeLiveChat,
} from "./innertube-chat.js";

/** Bot / system replies we post — never treat these as votes. */
const BOT_REPLY_RE =
  /\bvoted\b.+\bsuccessfully\b|Usage:\s*!vote|country not found|poll is not open|vote failed/i;

/**
 * @param {object} opts
 * @param {any} opts.youtube
 * @param {string} opts.broadcastId
 * @param {string} opts.apiBase local/tunnel origin for /api/poll/vote
 * @param {() => string|null} opts.getStreamId
 * @param {AbortSignal} [opts.signal]
 */
export async function startChatVoteLoop({
  youtube,
  broadcastId,
  apiBase,
  getStreamId,
  signal,
}) {
  const source = String(process.env.CHAT_VOTE_SOURCE || "innertube")
    .trim()
    .toLowerCase();

  if (source === "api") {
    console.log("[chat-vote] Source: YouTube Data API (uses quota)");
    return startApiChatVoteLoop({
      youtube,
      broadcastId,
      apiBase,
      getStreamId,
      signal,
    });
  }

  console.log(
    "[chat-vote] Source: Innertube live chat (no Data API list quota)"
  );
  try {
    await startInnertubeChatVoteLoop({
      youtube,
      broadcastId,
      apiBase,
      getStreamId,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    console.warn(
      "[chat-vote] Innertube failed, falling back to Data API:",
      err.message || err
    );
    return startApiChatVoteLoop({
      youtube,
      broadcastId,
      apiBase,
      getStreamId,
      signal,
    });
  }
}

async function startInnertubeChatVoteLoop({
  youtube,
  broadcastId,
  apiBase,
  getStreamId,
  signal,
}) {
  let session = null;
  for (let i = 0; i < 12; i++) {
    if (signal?.aborted) return;
    try {
      session = await openInnertubeLiveChat(broadcastId);
      break;
    } catch (err) {
      console.warn(
        `[chat-vote] Innertube not ready (${i + 1}/12):`,
        err.message || err
      );
      await sleep(4000);
    }
  }
  if (!session) {
    throw new Error("Could not open Innertube live chat");
  }

  let ownerChannelId = session.ownerChannelId;
  if (!ownerChannelId && youtube) {
    ownerChannelId = await resolveBroadcastOwnerChannelId(
      youtube,
      broadcastId
    );
  }

  const repliesOn =
    String(process.env.CHAT_VOTE_REPLIES || "1").trim() !== "0";
  console.log(
    "[chat-vote] Listening for !vote and bare country-name chat messages" +
      (ownerChannelId ? ` (skipping owner ${ownerChannelId})` : "") +
      (repliesOn ? "" : " (replies off)")
  );

  const seen = new Set();
  const replyAt = new Map();
  let liveChatId = null;

  while (!signal?.aborted) {
    try {
      const batch = await pollInnertubeLiveChat(session);
      if (batch.ended) {
        console.warn("[chat-vote] Innertube chat ended — reopening…");
        await sleep(5000);
        session = await openInnertubeLiveChat(broadcastId);
        continue;
      }
      session.continuation = batch.continuation;

      for (const item of batch.messages) {
        await handleChatMessage({
          id: item.id,
          text: item.text,
          authorName: item.authorName,
          channelId: item.channelId,
          isOwner: item.isOwner,
          ownerChannelId,
          seen,
          replyAt,
          youtube,
          getLiveChatId: async () => {
            if (!repliesOn) return null;
            if (!liveChatId) {
              liveChatId = await resolveLiveChatId(youtube, broadcastId);
            }
            return liveChatId;
          },
          repliesOn,
          apiBase,
          getStreamId,
        });
      }

      await sleep(batch.timeoutMs || 5000);
    } catch (err) {
      if (signal?.aborted) return;
      console.warn("[chat-vote] Innertube poll:", err.message || err);
      await sleep(8000);
      try {
        session = await openInnertubeLiveChat(broadcastId);
      } catch {
        /* retry next loop */
      }
    }
  }
}

async function startApiChatVoteLoop({
  youtube,
  broadcastId,
  apiBase,
  getStreamId,
  signal,
}) {
  const liveChatId = await resolveLiveChatId(youtube, broadcastId);
  if (!liveChatId) {
    console.warn("[chat-vote] No liveChatId yet — vote loop not started");
    return;
  }

  const ownerChannelId = await resolveBroadcastOwnerChannelId(
    youtube,
    broadcastId
  );
  const repliesOn =
    String(process.env.CHAT_VOTE_REPLIES || "1").trim() !== "0";
  console.log(
    "[chat-vote] Listening for !vote and bare country-name chat messages" +
      (ownerChannelId ? ` (skipping owner ${ownerChannelId})` : "") +
      (repliesOn ? "" : " (replies off)")
  );

  let pageToken = undefined;
  const seen = new Set();
  const replyAt = new Map();

  while (!signal?.aborted) {
    try {
      const res = await youtube.liveChatMessages.list({
        liveChatId,
        part: ["snippet", "authorDetails"],
        pageToken,
        maxResults: 50,
      });
      pageToken = res.data.nextPageToken || pageToken;
      const wait = Number(res.data.pollingIntervalMillis) || 5000;
      const items = res.data.items || [];

      for (const item of items) {
        if (item.snippet?.type && item.snippet.type !== "textMessageEvent") {
          continue;
        }
        const details = item.authorDetails || {};
        const text = String(
          item.snippet?.textMessageDetails?.messageText || ""
        ).trim();
        await handleChatMessage({
          id: item.id,
          text,
          authorName: details.displayName || details.channelId || "Viewer",
          channelId: details.channelId || "",
          isOwner: Boolean(details.isChatOwner),
          ownerChannelId,
          seen,
          replyAt,
          youtube,
          getLiveChatId: async () => (repliesOn ? liveChatId : null),
          repliesOn,
          apiBase,
          getStreamId,
        });
      }

      await sleep(Math.max(2000, wait));
    } catch (err) {
      if (signal?.aborted) return;
      console.warn("[chat-vote]", err.message || err);
      await sleep(8000);
    }
  }
}

async function handleChatMessage({
  id,
  text,
  authorName,
  channelId,
  isOwner,
  ownerChannelId,
  seen,
  replyAt,
  youtube,
  getLiveChatId,
  repliesOn,
  apiBase,
  getStreamId,
}) {
  if (!id || seen.has(id)) return;
  seen.add(id);
  if (seen.size > 2000) seen.clear();

  if (isOwner) return;
  if (ownerChannelId && channelId && channelId === ownerChannelId) return;

  const msg = String(text || "").trim();
  if (!msg) return;
  if (BOT_REPLY_RE.test(msg)) return;

  const parsed = parseVoteMessage(msg);
  if (!parsed) return;

  const author = authorName || channelId || "Viewer";
  const voterKey = channelId || author;

  const now = Date.now();
  if ((replyAt.get(voterKey) || 0) > now - 2500) return;
  replyAt.set(voterKey, now);

  const reply = async (messageText) => {
    if (!repliesOn) {
      console.log("[chat-vote]", messageText);
      return;
    }
    const liveChatId = await getLiveChatId();
    if (!liveChatId) {
      console.log("[chat-vote]", messageText);
      return;
    }
    await safeReply(youtube, liveChatId, messageText);
  };

  if (parsed.usage) {
    await reply(`${author} Usage: !vote Japan  or  just type Japan`);
    return;
  }

  const country = parsed.country;
  if (!country) {
    if (parsed.fromCommand) {
      await reply(
        `${author} country not found — try a name or 2-letter code.`
      );
    }
    return;
  }

  const streamId = getStreamId?.();
  if (!streamId) {
    if (parsed.fromCommand) {
      await reply(`${author} poll is not open yet.`);
    }
    return;
  }

  const vote = await castVote(
    apiBase,
    streamId,
    country.code,
    `yt:${voterKey}`,
    author
  );
  if (!vote.ok) {
    if (vote.error === "unknown_country" || vote.error === "not_an_option") {
      await reply(
        `${author} country not found — try a name or 2-letter code.`
      );
    } else if (vote.error === "poll_closed" && parsed.fromCommand) {
      await reply(`${author} poll is not open yet.`);
    } else if (parsed.fromCommand) {
      await reply(`${author} vote failed — try again.`);
    }
    return;
  }

  await reply(`${author} voted ${country.name} successfully`);
}

/**
 * @param {string} text
 * @returns {{ country: {code:string,name:string}|null, fromCommand: boolean, usage?: boolean } | null}
 */
export { parseVoteMessage } from "../../js/vote-message.js";

async function resolveLiveChatId(youtube, broadcastId) {
  if (!youtube) return null;
  for (let i = 0; i < 8; i++) {
    const res = await youtube.liveBroadcasts.list({
      part: ["snippet"],
      id: [broadcastId],
    });
    const id = res.data.items?.[0]?.snippet?.liveChatId;
    if (id) return id;
    await sleep(4000);
  }
  return null;
}

/** Channel that owns the broadcast (same account that posts bot replies). */
async function resolveBroadcastOwnerChannelId(youtube, broadcastId) {
  if (!youtube) return null;
  try {
    const res = await youtube.liveBroadcasts.list({
      part: ["snippet"],
      id: [broadcastId],
    });
    const id = res.data.items?.[0]?.snippet?.channelId;
    if (id) return id;
  } catch (err) {
    console.warn("[chat-vote] owner lookup failed:", err.message || err);
  }
  try {
    const mine = await youtube.channels.list({
      part: ["id"],
      mine: true,
    });
    return mine.data.items?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function castVote(apiBase, streamId, code, voterId, voterName) {
  const base = String(apiBase || "http://127.0.0.1:5173").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/poll/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, code, voterId, voterName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || `http_${res.status}` };
    }
    return { ok: true, poll: data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function safeReply(youtube, liveChatId, messageText) {
  try {
    await youtube.liveChatMessages.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: {
            messageText: String(messageText || "").slice(0, 200),
          },
        },
      },
    });
    console.log("[chat-vote]", messageText);
  } catch (err) {
    console.warn("[chat-vote] reply failed:", err.message || err);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
