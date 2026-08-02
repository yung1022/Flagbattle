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
2. Poll + rankings links are **posted to YouTube live chat** (pin manually in Studio — the API cannot pin).
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

### Trigger go-live from your own cronjob

GitHub’s scheduled cron is often delayed, so this workflow is **`workflow_dispatch` only**. Call it from your server cron (every 4 hours, etc.).

**1. Create a GitHub PAT** with permission to run Actions:
- Fine-grained: Actions **Read and write** on `yung1022/Flagbattle`, or
- Classic: `repo` + `workflow`

**2. Cron example** (full 30:00 qualifying, public, 40 minutes):

```bash
# crontab -e   →   0 */4 * * *
curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_PAT" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/yung1022/Flagbattle/actions/workflows/go-live.yml/dispatches \
  -d '{
    "ref": "main",
    "inputs": {
      "privacy": "public",
      "duration_minutes": "40",
      "demo_seconds": ""
    }
  }'
```

**Inputs you can set**

| Input | Default | Meaning |
|-------|---------|---------|
| `privacy` | `public` | `public` / `unlisted` / `private` |
| `duration_minutes` | `40` | Kill the Actions runner after N minutes |
| `demo_seconds` | `""` (empty) | Leave empty for full **30:00** qualifying; set e.g. `"120"` only for short tests |

Repo secrets still required: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

**Or** Actions UI → **Go Live — FLAG BATTLE** → **Run workflow** with the same inputs.
