/**
 * Post a single engagement Live Chat poll and leave it open.
 * YouTube allows only one active poll per chat — we never close this one.
 */
import { createLiveChatPoll } from "./youtube.js";

const POLL_RETRY_MS = 5000;
const QUESTION = "Do you like flag battles?";
const OPTIONS = ["Liked and Subscribed", "Yes", "No"];

/**
 * @param {{ youtube: any, broadcastId: string, signal?: AbortSignal }} opts
 */
export async function startYoutubePollOrchestrator({
  youtube,
  broadcastId,
  signal,
}) {
  console.log(
    `[yt-polls] Will post engagement poll once (never closed): "${QUESTION}"`
  );

  while (!signal?.aborted) {
    try {
      await createLiveChatPoll(youtube, broadcastId, QUESTION, OPTIONS);
      console.log(
        "[yt-polls] Engagement poll started — will not be closed for this stream"
      );
      // Stay alive until abort so the orchestrator doesn't look "crashed",
      // but never close the poll.
      await waitUntilAborted(signal);
      return;
    } catch (err) {
      console.warn(
        "[yt-polls] Waiting for live chat to post poll:",
        err.message || err
      );
      await sleep(POLL_RETRY_MS);
    }
  }
}

function waitUntilAborted(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
