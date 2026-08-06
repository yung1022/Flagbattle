/**
 * YouTube live chat !vote {code|country name} → poll API + chat replies.
 */
import { resolveCountryQuery } from "../../js/countries.js";

const VOTE_RE = /^!vote(?:\s+(.+))?$/i;

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
  console.log("[chat-vote] Listening for !vote commands");

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

        const text = item.snippet?.textMessageDetails?.messageText || "";
        const match = String(text).trim().match(VOTE_RE);
        if (!match) continue;

        const author =
          item.authorDetails?.displayName ||
          item.authorDetails?.channelId ||
          "Viewer";
        const channelId = item.authorDetails?.channelId || author;
        const query = String(match[1] || "").trim();
        const country = resolveCountryQuery(query);

        // Mild per-author throttle for replies.
        const now = Date.now();
        if ((replyAt.get(channelId) || 0) > now - 2500) continue;
        replyAt.set(channelId, now);

        if (!query) {
          await safeReply(
            youtube,
            liveChatId,
            `${author} Usage: !vote Japan  or  !vote jp`
          );
          continue;
        }

        if (!country) {
          await safeReply(
            youtube,
            liveChatId,
            `${author} country not found — try a name or 2-letter code.`
          );
          continue;
        }

        const streamId = getStreamId?.();
        if (!streamId) {
          await safeReply(
            youtube,
            liveChatId,
            `${author} poll is not open yet.`
          );
          continue;
        }

        const vote = await castVote(
          apiBase,
          streamId,
          country.code,
          `yt:${channelId}`
        );
        if (!vote.ok) {
          if (vote.error === "unknown_country" || vote.error === "not_an_option") {
            await safeReply(
              youtube,
              liveChatId,
              `${author} country not found — try a name or 2-letter code.`
            );
          } else if (vote.error === "poll_closed") {
            await safeReply(
              youtube,
              liveChatId,
              `${author} poll is not open yet.`
            );
          } else {
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

async function castVote(apiBase, streamId, code, voterId) {
  const base = String(apiBase || "http://127.0.0.1:5173").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/poll/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, code, voterId }),
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
