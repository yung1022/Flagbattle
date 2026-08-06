/**
 * Shared chat vote parsing (YouTube chat + Easy teststream demo).
 * Accepts "!vote Japan", "!vote jp", or a bare country name/code message.
 */
import { resolveCountryQuery } from "./countries.js";

const VOTE_CMD_RE = /^!vote(?:\s+(.+))?$/i;

/**
 * @param {string} text
 * @returns {{ country: {code:string,name:string}|null, fromCommand: boolean, usage?: boolean } | null}
 */
export function parseVoteMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const cmd = raw.match(VOTE_CMD_RE);
  if (cmd) {
    const query = String(cmd[1] || "").trim();
    if (!query) return { country: null, fromCommand: true, usage: true };
    return {
      country: resolveCountryQuery(query),
      fromCommand: true,
    };
  }

  // Bare message: whole chat line is a country name or code.
  // Ignore long chatter that only mentions a country in passing (> 6 words).
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > 6) return null;

  const country = resolveCountryQuery(raw);
  if (!country) return null;
  return { country, fromCommand: false };
}
