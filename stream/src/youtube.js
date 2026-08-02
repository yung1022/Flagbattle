import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SCOPES_HINT =
  "youtube / youtube.force-ssl (run: npm run auth --prefix stream)";

export function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `Missing OAuth env. Need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.\n${SCOPES_HINT}`
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/** Discovery tags for YouTube search / browse. */
export const DEFAULT_LIVE_TAGS = [
  "flag battle",
  "flags",
  "country flags",
  "last flag standing",
  "livestream",
  "live stream",
  "youtube shorts",
  "shorts live",
  "live game",
  "battle royale",
  "geography",
  "world flags",
  "flag game",
  "countries",
  "elimination game",
  "live gaming",
];

/**
 * Create broadcast + RTMP stream, bind, return ingestion + ids.
 */
export async function createLiveBroadcast({
  title,
  description,
  privacyStatus = "public",
  thumbnailPath,
  tags = DEFAULT_LIVE_TAGS,
  categoryId = "20", // Gaming
} = {}) {
  const auth = createOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });

  const scheduledStart = new Date(Date.now() + 30_000).toISOString();
  const tagList = Array.isArray(tags) && tags.length ? tags : DEFAULT_LIVE_TAGS;

  const broadcastRes = await youtube.liveBroadcasts.insert({
    part: ["snippet", "status", "contentDetails"],
    requestBody: {
      snippet: {
        title,
        description,
        scheduledStartTime: scheduledStart,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        monitorStream: { enableMonitorStream: false },
      },
    },
  });

  const broadcast = broadcastRes.data;
  const broadcastId = broadcast.id;

  // Tags + category live on the video resource (helps discovery).
  try {
    await youtube.videos.update({
      part: ["snippet"],
      requestBody: {
        id: broadcastId,
        snippet: {
          title,
          description,
          categoryId: String(categoryId || "20"),
          tags: tagList.slice(0, 30),
        },
      },
    });
    console.log(`YouTube tags set (${Math.min(tagList.length, 30)})`);
  } catch (err) {
    console.warn("Could not set video tags:", err.message || err);
  }

  const streamRes = await youtube.liveStreams.insert({
    part: ["snippet", "cdn", "contentDetails", "status"],
    requestBody: {
      snippet: {
        title: `${title} · ingest`,
      },
      cdn: {
        frameRate: "30fps",
        ingestionType: "rtmp",
        resolution: "1080p",
      },
    },
  });

  const stream = streamRes.data;
  const streamId = stream.id;
  const ingestion = stream.cdn?.ingestionInfo;
  if (!ingestion?.ingestionAddress || !ingestion?.streamName) {
    throw new Error("YouTube did not return RTMP ingestion info");
  }

  await youtube.liveBroadcasts.bind({
    id: broadcastId,
    part: ["id", "contentDetails"],
    streamId,
  });

  const thumb = await resolveThumbnailFile(thumbnailPath);
  if (thumb) {
    await setVideoThumbnail(youtube, broadcastId, thumb);
  } else {
    console.warn("No usable thumbnail file found (need JPEG/PNG under 2MB)");
  }

  const rtmpUrl = `${ingestion.ingestionAddress}/${ingestion.streamName}`;
  const watchUrl = `https://www.youtube.com/watch?v=${broadcastId}`;

  return {
    youtube,
    broadcastId,
    streamId,
    rtmpUrl,
    watchUrl,
    streamName: ingestion.streamName,
    ingestionAddress: ingestion.ingestionAddress,
    thumbnailPath: thumb,
  };
}

/** YouTube custom thumbs must be < 2MB — prefer compressed JPEG assets. */
export async function resolveThumbnailFile(preferred) {
  const candidates = [
    preferred,
    preferred && preferred.replace(/\.png$/i, "-yt.jpg"),
    preferred && path.join(path.dirname(preferred), "thumbnail-yt.jpg"),
    preferred && path.join(path.dirname(preferred), "thumbnail-yt-1280.jpg"),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size > 2 * 1024 * 1024) {
      console.warn(`Thumbnail too large (${size} bytes): ${file}`);
      continue;
    }
    return file;
  }

  // Last resort: compress PNG → JPEG with ffmpeg if available.
  if (preferred && fs.existsSync(preferred)) {
    const out = path.join(path.dirname(preferred), "thumbnail-yt-runtime.jpg");
    const ok = await compressThumbnail(preferred, out);
    if (ok && fs.existsSync(out) && fs.statSync(out).size <= 2 * 1024 * 1024) {
      return out;
    }
  }
  return null;
}

function compressThumbnail(input, output) {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        input,
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
        "-frames:v",
        "1",
        "-update",
        "1",
        "-q:v",
        "4",
        output,
      ],
      { stdio: "ignore" }
    );
    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function setVideoThumbnail(youtube, videoId, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("thumbnail file missing");
  }
  const size = fs.statSync(filePath).size;
  if (size > 2 * 1024 * 1024) {
    throw new Error(`thumbnail exceeds 2MB (${size} bytes)`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
        ? "image/png"
        : "application/octet-stream";

  try {
    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType,
        body: fs.createReadStream(filePath),
      },
    });
    console.log(`Thumbnail set from ${path.basename(filePath)} (${size} bytes)`);
    return true;
  } catch (err) {
    const msg = err.message || String(err);
    console.warn("Thumbnail upload failed:", msg);
    if (/forbidden|verified|permission/i.test(msg)) {
      console.warn(
        "Custom thumbnails require a verified YouTube channel (and youtube.force-ssl scope)."
      );
    }
    return false;
  }
}

/** Wait until YouTube sees the ingest, then transition broadcast → live. */
export async function goLive(youtube, broadcastId, { timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await youtube.liveBroadcasts.list({
      part: ["status", "contentDetails", "snippet"],
      id: [broadcastId],
    });
    const item = res.data.items?.[0];
    const life = item?.status?.lifeCycleStatus;
    const streamStatus = item?.status?.streamStatus;
    console.log(`Broadcast status: life=${life} stream=${streamStatus}`);

    if (life === "live") return item;
    if (life === "ready" || life === "testing" || streamStatus === "active") {
      try {
        await youtube.liveBroadcasts.transition({
          broadcastStatus: "live",
          id: broadcastId,
          part: ["status", "snippet"],
        });
        console.log("Transitioned broadcast to live");
        const again = await youtube.liveBroadcasts.list({
          part: ["snippet", "status"],
          id: [broadcastId],
        });
        return again.data.items?.[0] || item;
      } catch (err) {
        console.warn("transition not ready yet:", err.message || err);
      }
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting to go live");
}

/**
 * Post poll/rankings links to live chat.
 * Note: YouTube Data API cannot pin chat messages — pin manually in Studio if needed.
 */
export async function postLiveChatMessage(youtube, broadcastId, messageText) {
  const res = await youtube.liveBroadcasts.list({
    part: ["snippet"],
    id: [broadcastId],
  });
  const liveChatId = res.data.items?.[0]?.snippet?.liveChatId;
  if (!liveChatId) {
    throw new Error("liveChatId not available yet (broadcast may not be live)");
  }
  const text = String(messageText || "").slice(0, 200);
  const inserted = await youtube.liveChatMessages.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        liveChatId,
        type: "textMessageEvent",
        textMessageDetails: { messageText: text },
      },
    },
  });
  console.log("Posted live chat message:", text);
  console.warn(
    "Pinning is not available via YouTube API — pin this message manually in YouTube Studio / mobile Live chat."
  );
  return inserted.data;
}

export async function completeBroadcast(youtube, broadcastId) {
  try {
    await youtube.liveBroadcasts.transition({
      broadcastStatus: "complete",
      id: broadcastId,
      part: ["status"],
    });
    console.log("Broadcast marked complete");
  } catch (err) {
    console.warn("complete transition:", err.message || err);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
