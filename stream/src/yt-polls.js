/**
 * Orchestrate YouTube Live Chat polls during a stream.
 *
 * YouTube allows only ONE active poll per chat, so we sequence:
 *  1) "Who will win the poll?" — top 4 from the site/Nightbot vote poll
 *  2) "Who wins Final 4?" — the four finalists when battling starts
 *
 * Close the active poll when the stream finishes.
 */
import {
  createLiveChatPoll,
  closeLiveChatPoll,
} from "./youtube.js";

const POLL_INTERVAL_MS = 5000;
const MIN_VOTES_FOR_COMMUNITY_POLL = 5;

/** @param {{ youtube: any, broadcastId: string, port: number, mode?: string, signal?: AbortSignal }} opts */
export async function startYoutubePollOrchestrator({
  youtube,
  broadcastId,
  port,
  mode = "qualifying",
  signal,
}) {
  let activePollId = null;
  let postedCommunity = false;
  let postedFinal4 = false;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  signal?.addEventListener("abort", stop, { once: true });

  console.log(
    "[yt-polls] Watching for community-poll + Final 4 Live Chat polls"
  );

  while (!stopped && !signal?.aborted) {
    try {
      await tick();
    } catch (err) {
      console.warn("[yt-polls]", err.message || err);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (activePollId) {
    await closeLiveChatPoll(youtube, activePollId);
    activePollId = null;
  }

  async function tick() {
    const liveRes = await fetchJson(`http://127.0.0.1:${port}/api/live`);
    const live = liveRes?.live;
    if (!live) return;

    if (live.phase === "finished") {
      if (activePollId) {
        await closeLiveChatPoll(youtube, activePollId);
        activePollId = null;
      }
      postedFinal4 = true;
      postedCommunity = true;
      return;
    }

    // Sprint is chat-spawn only — wait until Qualifying before pinning a poll.
    if (
      live.sprintActive ||
      live.phase === "sprint" ||
      (Number(live.sprintRemainingMs) || 0) > 0
    ) {
      return;
    }

    // Final 4 battling — switch to finalist poll (replaces community poll).
    if (
      !postedFinal4 &&
      live.finalStage === "battle" &&
      Array.isArray(live.standing) &&
      live.standing.length >= 2
    ) {
      const options = uniqueOptions(
        live.standing.slice(0, 4).map((f) => formatOption(f))
      );
      if (options.length >= 2) {
        if (activePollId) {
          await closeLiveChatPoll(youtube, activePollId);
          activePollId = null;
        }
        const created = await createLiveChatPoll(
          youtube,
          broadcastId,
          "Who wins Final 4?",
          options
        );
        activePollId = created?.id || null;
        postedFinal4 = true;
        postedCommunity = true;
        return;
      }
    }

    if (postedCommunity || postedFinal4) return;

    const streamId = live.streamId;
    if (!streamId) return;

    const poll = await fetchJson(
      `http://127.0.0.1:${port}/api/poll?streamId=${encodeURIComponent(streamId)}`
    );
    const ranked = rankPollOptions(poll);
    if (ranked.length < 2) return;

    const totalVotes = ranked.reduce((n, r) => n + r.votes, 0);
    if (totalVotes < 1) return; // don't pin arbitrary zero-vote countries

    const inFinal =
      mode === "final" ||
      live.mode === "final" ||
      live.phase === "final" ||
      live.phase === "qualifying_complete" ||
      Boolean(live.finalStage);

    // Wait for a few site votes during Qualifying so top-4 is meaningful.
    if (!inFinal && totalVotes < MIN_VOTES_FOR_COMMUNITY_POLL) return;

    const options = uniqueOptions(
      ranked.slice(0, 4).map((r) => formatOption(r))
    );
    if (options.length < 2) return;

    const created = await createLiveChatPoll(
      youtube,
      broadcastId,
      "Who will win the poll?",
      options
    );
    activePollId = created?.id || null;
    postedCommunity = true;
  }
}

function formatOption(row) {
  const name = String(row?.name || row?.code || "?").trim();
  const code = String(row?.code || "").trim().toUpperCase();
  if (code && !name.toUpperCase().includes(code)) {
    return `${name} (${code})`.slice(0, 60);
  }
  return name.slice(0, 60);
}

function uniqueOptions(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = String(raw || "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function rankPollOptions(poll) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const votes = poll?.votes || {};
  return [...options]
    .map((o) => ({
      code: o.code,
      name: o.name,
      votes: Number(votes[o.code]) || 0,
    }))
    .sort(
      (a, b) =>
        b.votes - a.votes ||
        String(a.name || "").localeCompare(String(b.name || ""))
    );
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
