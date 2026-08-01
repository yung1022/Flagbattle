/**
 * Push data/* into the GitHub repo so GitHub Pages can serve ranking history.
 * Uses GITHUB_TOKEN / GH_PAT (contents:write).
 */
import fs from "node:fs";
import path from "node:path";

const token =
  process.env.GH_PAT ||
  process.env.PAGES_SYNC_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  "";
const repo =
  process.env.GITHUB_REPOSITORY ||
  process.env.GH_REPO ||
  "yung1022/Flagbattle";
const branch = process.env.GITHUB_DATA_BRANCH || "main";

let queue = Promise.resolve();
const lastSha = new Map();
const lastBody = new Map();

export function githubSyncEnabled() {
  return Boolean(token && repo);
}

async function gh(pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || text || res.statusText;
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  return data;
}

async function putFile(relPath, content, message) {
  if (!githubSyncEnabled()) return false;
  const bodyStr =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (lastBody.get(relPath) === bodyStr) return false;

  const apiPath = `/repos/${repo}/contents/${relPath.replace(/^\//, "")}`;
  let sha = lastSha.get(relPath);
  if (!sha) {
    try {
      const existing = await gh(
        `${apiPath}?ref=${encodeURIComponent(branch)}`
      );
      sha = existing.sha;
      lastSha.set(relPath, sha);
    } catch {
      sha = undefined;
    }
  }

  const payload = {
    message,
    content: Buffer.from(bodyStr, "utf8").toString("base64"),
    branch,
  };
  if (sha) payload.sha = sha;

  try {
    const result = await gh(apiPath, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const newSha = result.content?.sha;
    if (newSha) lastSha.set(relPath, newSha);
    lastBody.set(relPath, bodyStr);
    console.log(`[github-sync] wrote ${relPath}`);
    return true;
  } catch (err) {
    // Sha conflict — refresh and retry once.
    if (String(err.message || err).includes("409") || String(err).includes("sha")) {
      lastSha.delete(relPath);
      const existing = await gh(
        `${apiPath}?ref=${encodeURIComponent(branch)}`
      );
      lastSha.set(relPath, existing.sha);
      const retry = await gh(apiPath, {
        method: "PUT",
        body: JSON.stringify({
          ...payload,
          sha: existing.sha,
        }),
      });
      if (retry.content?.sha) lastSha.set(relPath, retry.content.sha);
      lastBody.set(relPath, bodyStr);
      console.log(`[github-sync] wrote ${relPath} (retry)`);
      return true;
    }
    console.warn(`[github-sync] ${relPath}:`, err.message || err);
    return false;
  }
}

export function enqueueGithubFile(relPath, content, message) {
  if (!githubSyncEnabled()) return;
  queue = queue
    .then(() => putFile(relPath, content, message))
    .catch((err) => console.warn("[github-sync]", err.message || err));
  return queue;
}

export function mirrorAndSync(rootDir, relPath, data, message) {
  const abs = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  fs.writeFileSync(abs, body);
  return enqueueGithubFile(relPath, body, message);
}
