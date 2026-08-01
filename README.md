# FLAG BATTLE

Vertical **9:16** all-country flag battle for YouTube Shorts livestreams.

**Public site:** [yung1022.github.io/Flagbattle](https://yung1022.github.io/Flagbattle)

## Rules

1. **1:00 intermission** at stream start (also in demo mode).
2. **Qualifying (full 30:00)** — every non-qualified country each round; last flag qualifies.  
   **No qualifier cap** — rounds continue for the full clock; Final includes everyone who qualified.
3. **1:00 intermission** before the Final.
4. **Final — Last Flag Standing** among all qualifiers.

## Viewer pages (GitHub Pages)

| Page | URL |
|------|-----|
| Arena | https://yung1022.github.io/Flagbattle/ |
| Rankings history | https://yung1022.github.io/Flagbattle/rankings.html |
| Final poll | https://yung1022.github.io/Flagbattle/poll.html |
| Mobile go-live | https://yung1022.github.io/Flagbattle/control/ |

Stream ranking history is stored in [`data/rankings.json`](data/rankings.json) and published with Pages after each go-live.

### How polls work for viewers

1. Go-live starts a **Cloudflare quick tunnel** to the stream API.
2. On-stream QR codes point at **GitHub Pages** with `?api=<tunnel>` (not `127.0.0.1`).
3. Votes hit the tunnel; rankings/poll snapshots are also mirrored into `data/` for history.

## Local run

```bash
node server.mjs
```

Open `http://localhost:5173` — QR/links still use GitHub Pages by default.

### Auto-stream

```bash
# cloudflared recommended so phones can vote
PUBLIC_SITE=https://yung1022.github.io/Flagbattle npm run go-live --prefix stream
```

Subscriber count uses `stream/.env` OAuth (livestream account), or:

```env
YOUTUBE_API_KEY=...
YT_CHANNEL_ID=UCxxxx
# or YT_CHANNEL_HANDLE=@YourHandle
```

## Mobile / cloud stream

See [`control/`](control/) and [`stream/`](stream/). Repo Action secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- Optional `GH_PAT` (contents write) for data commits that retrigger Pages

### Automatic schedule

GitHub Action **Go Live — FLAG BATTLE** runs every **4 hours** (UTC):

- **Public** livestream
- Full **30:00** qualifying (no demo shorten)
- Runner stops after **40 minutes**
- Discovery tags + Gaming category on the YouTube video
- Capture at 720×1280 / `ultrafast` for smoother Actions encode
