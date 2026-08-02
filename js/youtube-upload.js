/**
 * Browser-side YouTube resumable upload (Shorts / vertical VODs).
 * Uses OAuth refresh token from the control hub Setup tab.
 */

export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "token refresh failed");
  }
  return data.access_token;
}

/**
 * Upload a video blob and return the YouTube watch URL.
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {Blob} opts.blob
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {string[]} [opts.tags]
 * @param {string} [opts.privacyStatus]
 * @param {string} [opts.categoryId]
 */
export async function uploadYoutubeShort({
  accessToken,
  blob,
  title,
  description = "",
  tags = [
    "flag battle",
    "shorts",
    "youtube shorts",
    "flags",
    "last flag standing",
    "highlights",
  ],
  privacyStatus = "public",
  categoryId = "20",
}) {
  if (!accessToken) throw new Error("accessToken required");
  if (!blob?.size) throw new Error("empty video blob");

  const metadata = {
    snippet: {
      title: String(title || "FLAG BATTLE Highlights").slice(0, 100),
      description: String(
        description ||
          "FLAG BATTLE final results highlight. #Shorts #FlagBattle"
      ).slice(0, 5000),
      tags: tags.slice(0, 30),
      categoryId: String(categoryId || "20"),
    },
    status: {
      privacyStatus: privacyStatus || "public",
      selfDeclaredMadeForKids: false,
      // Helps Shorts shelf when vertical + #Shorts in title/desc.
      madeForKids: false,
    },
  };

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(blob.size),
        "X-Upload-Content-Type": blob.type || "video/webm",
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(
      err.error?.message || JSON.stringify(err) || initRes.statusText
    );
  }
  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("No resumable upload Location header");

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": blob.type || "video/webm",
      "Content-Length": String(blob.size),
    },
    body: blob,
  });
  const data = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    throw new Error(data.error?.message || JSON.stringify(data) || putRes.statusText);
  }
  const id = data.id;
  if (!id) throw new Error("Upload succeeded but no video id returned");
  return {
    id,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    shortsUrl: `https://www.youtube.com/shorts/${id}`,
    data,
  };
}
