/**
 * Public livestream cadence: every 2 hours on the UTC clock
 * (00:00, 02:00, …, 22:00 UTC).
 */

export const LIVE_SLOT_MS = 2 * 60 * 60 * 1000;

/** Next 2-hour UTC slot strictly after `fromMs` (ISO string). */
export function nextLiveSlotUtc(fromMs = Date.now()) {
  const t = Number(fromMs) || Date.now();
  const next = Math.ceil((t + 1) / LIVE_SLOT_MS) * LIVE_SLOT_MS;
  return new Date(next).toISOString();
}

/** Format a slot for on-stream display. */
export function formatLiveSlot(iso, now = Date.now()) {
  if (!iso) return "TBD";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "TBD";
  const d = new Date(t);
  const utc = d.toLocaleString("en-GB", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const delta = t - now;
  if (delta <= 0) return `${utc} UTC (soon)`;
  const mins = Math.round(delta / 60_000);
  if (mins < 120) return `${utc} UTC (in ${mins}m)`;
  const hours = Math.round(mins / 60);
  return `${utc} UTC (in ${hours}h)`;
}
