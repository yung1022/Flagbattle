/**
 * YouTube live chat votes → poll API + optional chat replies.
 * Accepts "!vote Japan", "!vote jp", or a bare country name/code message.
 *
 * Never counts the broadcaster / bot account — their reply messages (and the
 * host's own chat) used to re-parse as votes and loop.
 */
import { parseVoteMessage } from "../../js/vote-message.js";

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
  const liveChatId = await resolveLiveChatId(youtube, broadcastId);
  if (!liveChatId) {
    console.warn("[chat-vote] No liveChatId yet — vote loop not started");
    return;
  }

  const ownerChannelId = await resolveBroadcastOwnerChannelId(
    youtube,
    broadcastId
  );
  console.log(
    "[chat-vote] Listening for !vote and bare country-name chat messages" +
      (ownerChannelId ? ` (skipping owner ${ownerChannelId})` : "")
  );

  let pageToken = undefined;
  const seen = new Set();
  const replyAt = new Map(); // author → last reply ms

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
        const id = item.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 2000) {
          seen.clear();
        }

        // Skip bot / system message types that aren't plain chat.
        if (item.snippet?.type && item.snippet.type !== "textMessageEvent") {
          continue;
        }

        const details = item.authorDetails || {};
        const channelId = details.channelId || "";
        // Host + OAuth bot post as chat owner — counting them causes a reply loop.
        if (details.isChatOwner) continue;
        if (ownerChannelId && channelId && channelId === ownerChannelId) {
          continue;
        }

        const text = String(
          item.snippet?.textMessageDetails?.messageText || ""
        ).trim();
        if (!text) continue;
        if (BOT_REPLY_RE.test(text)) continue;

        const parsed = parseVoteMessage(text);
        if (!parsed) continue;

        const author = details.displayName || channelId || "Viewer";
        const voterKey = channelId || author;

        // Mild per-author throttle for replies + duplicate casts.
        const now = Date.now();
        if ((replyAt.get(voterKey) || 0) > now - 2500) continue;
        replyAt.set(voterKey, now);

        if (parsed.usage) {
          await safeReply(
            youtube,
            liveChatId,
            `${author} Usage: !vote Japan  or  just type Japan`
          );
          continue;
        }

        const country = parsed.country;
        if (!country) {
          if (parsed.fromCommand) {
            await safeReply(
              youtube,
              liveChatId,
              `${author} country not found — try a name or 2-letter code.`
            );
          }
          continue;
        }

        const streamId = getStreamId?.();
        if (!streamId) {
          if (parsed.fromCommand) {
            await safeReply(
              youtube,
              liveChatId,
              `${author} poll is not open yet.`
            );
          }
          continue;
        }

        const vote = await castVote(
          apiBase,
          streamId,
          country.code,
          `yt:${voterKey}`,
          author
        );
        if (!vote.ok) {
          if (
            vote.error === "unknown_country" ||
            vote.error === "not_an_option"
          ) {
            await safeReply(
              youtube,
              liveChatId,
              `${author} country not found — try a name or 2-letter code.`
            );
          } else if (vote.error === "poll_closed" && parsed.fromCommand) {
            await safeReply(
              youtube,
              liveChatId,
              `${author} poll is not open yet.`
            );
          } else if (parsed.fromCommand) {
            await safeReply(
              youtube,
              liveChatId,
              `${author} vote failed — try again.`
            );
          }
          continue;
        }

        await safeReply(
          youtube,
          liveChatId,
          `${author} voted ${country.name} successfully`
        );
      }

      await sleep(Math.max(2000, wait));
    } catch (err) {
      if (signal?.aborted) return;
      console.warn("[chat-vote]", err.message || err);
      await sleep(8000);
    }
  }
}

/**
 * @param {string} text
 * @returns {{ country: {code:string,name:string}|null, fromCommand: boolean, usage?: boolean } | null}
 */
export { parseVoteMessage } from "../../js/vote-message.js";

async function resolveLiveChatId(youtube, broadcastId) {
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
