# FLAG BATTLE

Vertical **9:16** all-country flag battle for YouTube Shorts livestreams.

## Rules

1. **Qualifying (30 minutes)** — Heats of flags fight inside a **circle with a rotating hole**.  
   - No damage between flags (they only bounce).  
   - Touch the hole → you fall out.  
   - **Last flag standing in the round qualifies** for the Final.  
   - Top board shows **QUALIFIED FOR FINAL**.
2. **Final — Last Flag Standing** — Same hole-circle rules among qualifiers. Top board shows **FLAGS STANDING**.

Default: **32** finalist slots · heats of **48**.

## Run locally (preview)

```bash
npx --yes serve -l 5173 .
```

| Mode | URL |
|------|-----|
| Host controls | `/` |
| Clean stream view | `/?stream=1&autostart=1` |
| Fast demo | `/?demo=45&stream=1&autostart=1` |

## Auto-stream (no OBS)

The `stream/` package **creates a YouTube Live broadcast via API** and pushes the arena with **Xvfb + Chrome + FFmpeg** — no streaming software.

### One-time setup

1. Google Cloud → enable **YouTube Data API v3** → create **OAuth Desktop** client.
2. Copy credentials:

```bash
cp stream/.env.example stream/.env
# fill GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
```

3. Authorize (saves refresh token):

```bash
npm install --prefix stream
npm run auth --prefix stream
```

### Go live from your machine

```bash
npm run go-live --prefix stream
# or a short demo stream:
npm run go-live:demo --prefix stream
```

Optional flags: `--demo 90` · `--privacy unlisted` · `--title "…"`.

### GitHub Actions workflow

Workflow: [`.github/workflows/go-live.yml`](.github/workflows/go-live.yml)

Add repo secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.  
Then **Actions → Go Live — FLAG BATTLE → Run workflow**.

## Thumbnail

[`assets/thumbnail.png`](assets/thumbnail.png)

## Stack

- Vanilla HTML / CSS / JS arena
- Flags from [flagcdn.com](https://flagcdn.com)
- Auto-stream: `googleapis` + FFmpeg RTMP ingest
