# FLAG BATTLE

Vertical **9:16** all-country flag battle for YouTube Shorts livestreams.

## Rules

1. **1:00 intermission** at stream start.
2. **Qualifying (full 30:00)** — every non-qualified country each round; last flag qualifies.  
   If all 32 slots fill early, the stream **holds until the clock ends** (does not skip to Final).
3. **1:00 intermission** before the Final.
4. **Final — Last Flag Standing** among qualifiers.

## Run (rankings + poll API)

```bash
node server.mjs
```

Open `http://localhost:5173`

| Page | URL |
|------|-----|
| Arena | `/` |
| Rankings (per stream / per round) | `/rankings.html` |
| Final poll | `/poll.html` |
| Mobile go-live | `/control/` |
| Stream view | `/?stream=1&autostart=1` |

### On-stream poll & rankings

The livestream overlay shows:
- **QR + URL** for the poll and rankings pages
- **Live poll results** during final intermission / Final

Pass your public site so viewers get a scannable link:

```bash
# example GitHub Pages
node server.mjs
# open: /?stream=1&autostart=1&site=https://yung1022.github.io/Flagbattle

# auto-stream
PUBLIC_SITE=https://yung1022.github.io/Flagbattle npm run go-live --prefix stream
```

## Fixes in this build

- Larger HUD text, inset from YouTube Shorts UI edges
- Qualifying lasts the full 30 minutes
- Faster flag movement + spatial collision grid (less lag)
- Poll/rankings links + live poll board on the stream

## Mobile / cloud stream

See [`control/`](control/) and [`stream/`](stream/). Repo Action secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

GitHub PAT for the phone hub can be named anything; it needs **Actions** write (+ **Secrets** write to push credentials).
