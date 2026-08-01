/** Shared public site / live API helpers for Pages + local server. */

export const DEFAULT_PUBLIC_SITE = "https://yung1022.github.io/Flagbattle";

export function isLocalHost(hostname = location.hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** Public site root for QR/links (never 127.0.0.1 for viewers). */
export function siteBase(search = location.search) {
  const params = new URLSearchParams(search);
  const override =
    params.get("site") ||
    params.get("publicBase") ||
    (typeof localStorage !== "undefined"
      ? localStorage.getItem("flagbattle.siteBase")
      : null);
  if (override) return String(override).replace(/\/$/, "");

  if (isLocalHost()) return DEFAULT_PUBLIC_SITE;

  const parts = location.pathname.split("/").filter(Boolean);
  if (location.hostname.endsWith("github.io") && parts.length) {
    return `${location.origin}/${parts[0]}`;
  }
  return location.origin;
}

/** Static JSON on GitHub Pages (ranking history / live pointer). */
export function pagesDataUrl(file) {
  const base = siteBase();
  return `${base}/data/${file.replace(/^\//, "")}`;
}

let cachedApiBase = undefined;

export function resetApiBaseCache() {
  cachedApiBase = undefined;
}

/**
 * Live API origin for votes / fresh rankings.
 * Order: ?api= → localStorage → data/live.json → same-origin on localhost.
 */
export async function resolveApiBase(search = location.search) {
  if (cachedApiBase !== undefined) return cachedApiBase;

  const params = new URLSearchParams(search);
  const fromParam = params.get("api");
  if (fromParam) {
    cachedApiBase = String(fromParam).replace(/\/$/, "");
    try {
      localStorage.setItem("flagbattle.apiBase", cachedApiBase);
    } catch {
      /* ignore */
    }
    return cachedApiBase;
  }

  try {
    const stored = localStorage.getItem("flagbattle.apiBase");
    if (stored) {
      cachedApiBase = stored.replace(/\/$/, "");
      return cachedApiBase;
    }
  } catch {
    /* ignore */
  }

  try {
    const res = await fetch(pagesDataUrl("live.json"), { cache: "no-store" });
    if (res.ok) {
      const live = await res.json();
      if (live?.api) {
        cachedApiBase = String(live.api).replace(/\/$/, "");
        return cachedApiBase;
      }
    }
  } catch {
    /* ignore */
  }

  if (isLocalHost()) {
    cachedApiBase = location.origin;
    return cachedApiBase;
  }

  cachedApiBase = "";
  return cachedApiBase;
}

export async function apiFetch(path, opts = {}) {
  const base = await resolveApiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      cache: "no-store",
      ...opts,
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) return await res.json();
    return await res.text();
  } catch {
    return null;
  }
}
