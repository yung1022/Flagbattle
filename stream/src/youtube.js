import { google } from "googleapis";

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

/**
 * Create broadcast + RTMP stream, bind, return ingestion + ids.
 */
export async function createLiveBroadcast({
  title,
  description,
  privacyStatus = "public",
  thumbnailPath,
} = {}) {
  const auth = createOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });

  const scheduledStart = new Date(Date.now() + 30_000).toISOString();

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

  if (thumbnailPath) {
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(thumbnailPath)) {
        await youtube.thumbnails.set({
          videoId: broadcastId,
          media: {
            mimeType: "image/png",
            body: fs.createReadStream(thumbnailPath),
          },
        });
      }
    } catch (err) {
      console.warn("Thumbnail upload skipped:", err.message || err);
    }
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
  };
}

/** Wait until YouTube sees the ingest, then transition broadcast → live. */
export async function goLive(youtube, broadcastId, { timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await youtube.liveBroadcasts.list({
      part: ["status", "contentDetails"],
      id: [broadcastId],
    });
    const item = res.data.items?.[0];
    const life = item?.status?.lifeCycleStatus;
    const streamStatus = item?.status?.streamStatus;
    console.log(`Broadcast status: life=${life} stream=${streamStatus}`);

    if (life === "live") return;
    if (life === "ready" || life === "testing" || streamStatus === "active") {
      try {
        await youtube.liveBroadcasts.transition({
          broadcastStatus: "live",
          id: broadcastId,
          part: ["status"],
        });
        console.log("Transitioned broadcast to live");
        return;
      } catch (err) {
        console.warn("transition not ready yet:", err.message || err);
      }
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting to go live");
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
