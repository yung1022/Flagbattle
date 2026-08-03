/**
 * Keep Nightbot's !vote command pointed at the current go-live tunnel.
 *
 * Needs NIGHTBOT_TOKEN (OAuth access token with `commands` scope).
 * Optional: NIGHTBOT_COMMAND_NAME (default !vote), NIGHTBOT_COOLDOWN (default 3).
 */

const API = "https://api.nightbot.tv/1";

export function nightbotVoteMessage(apiBase) {
  const base = String(apiBase || "").replace(/\/$/, "");
  if (!base) {
    return "Poll is offline — try the link in chat.";
  }
  // Nightbot $(urlfetch) is GET-only; response must be plain text < 400 chars.
  return `$(urlfetch ${base}/api/poll/vote?code=$(query)&voter=$(user)&format=text)`;
}

/**
 * Create or update the !vote custom command for the authorized Nightbot channel.
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
export async function syncNightbotVoteCommand(apiBase) {
  const token = (
    process.env.NIGHTBOT_TOKEN ||
    process.env.NIGHTBOT_ACCESS_TOKEN ||
    ""
  ).trim();
  if (!token) {
    return { ok: false, error: "NIGHTBOT_TOKEN not set" };
  }

  const name = (process.env.NIGHTBOT_COMMAND_NAME || "!vote").trim() || "!vote";
  const coolDown = Math.max(0, Number(process.env.NIGHTBOT_COOLDOWN || 3) || 3);
  const message = nightbotVoteMessage(apiBase);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  let commands = [];
  try {
    const listRes = await fetch(`${API}/commands`, { headers: { Authorization: `Bearer ${token}` } });
    const listData = await listRes.json().catch(() => ({}));
    if (!listRes.ok) {
      return {
        ok: false,
        error: listData.message || listData.error || `list_http_${listRes.status}`,
      };
    }
    commands = Array.isArray(listData.commands) ? listData.commands : [];
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }

  const existing =
    commands.find((c) => String(c.name || "").toLowerCase() === name.toLowerCase()) ||
    null;

  const body = new URLSearchParams({
    message,
    coolDown: String(coolDown),
    userLevel: "everyone",
  });
  if (!existing) body.set("name", name);

  try {
    const url = existing
      ? `${API}/commands/${existing._id}`
      : `${API}/commands`;
    const res = await fetch(url, {
      method: existing ? "PUT" : "POST",
      headers,
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: data.message || data.error || `http_${res.status}`,
      };
    }
    const id = data.command?._id || existing?._id;
    console.log(
      `[nightbot] ${existing ? "Updated" : "Created"} ${name} → ${apiBase}`
    );
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
