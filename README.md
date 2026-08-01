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

## Mobile only (no PC)

Open the control hub on your phone:

**`/control/`** → after GitHub Pages is on:  
`https://<you>.github.io/Flagbattle/control/`

### Path A — Easy (YouTube app screen share)

1. Open **Easy** tab → **Open arena**
2. YouTube app → **Go live** → **Share screen** → pick the browser
3. Keep FLAG BATTLE on screen (use **Fullscreen**; phone stays awake)

### Path B — Cloud (one-tap, no screen share)

One-time on your phone (**Setup** tab):

1. Google Cloud → enable **YouTube Data API v3**
2. OAuth client type: **TVs and Limited Input devices**
3. Paste Client ID + Secret → **Start device login** → approve at [google.com/device](https://www.google.com/device)
4. Create a GitHub PAT with **Actions** (+ **Secrets** if pushing from the hub)
5. Fill repo + PAT on **Cloud** tab → **Push secrets to GitHub**

Every stream after that: **Cloud → Go live now**.

GitHub Actions creates the YouTube broadcast and pushes 1080×1920 with FFmpeg (no OBS, no PC left on).

## Run locally (preview)

```bash
npx --yes serve -l 5173 .
```

| Mode | URL |
|------|-----|
| Host controls | `/` |
| Mobile control hub | `/control/` |
| Clean stream view | `/?stream=1&autostart=1` |
| Mobile stream helpers | `/?stream=1&autostart=1&mobile=1` |
| Fast demo | `/?demo=45&stream=1&autostart=1` |

## Desktop / server auto-stream

```bash
cp stream/.env.example stream/.env
npm install --prefix stream
# Desktop OAuth:
npm run auth --prefix stream
# Or phone-friendly device code (TV OAuth client):
npm run auth:device --prefix stream
npm run go-live --prefix stream
```

## Thumbnail

[`assets/thumbnail.png`](assets/thumbnail.png)

## Stack

- Vanilla HTML / CSS / JS arena
- Flags from [flagcdn.com](https://flagcdn.com)
- Mobile control hub + GitHub Actions / FFmpeg RTMP ingest
