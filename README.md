# FLAG BATTLE

Vertical **9:16** all-country flag battle for YouTube Shorts livestreams.

**Public site:** [yung1022.github.io/Flagbattle](https://yung1022.github.io/Flagbattle)

## Rules

Qualifying and Final are **separate livestreams**.

### Qualifying livestream
1. **1:00 intermission** at stream start.
2. **Qualifying clock (full 30:00)** — every non-qualified country each round; last flag qualifies.
3. Stream ends when the clock finishes — results save (`qualified` list). No Final in this stream.

### Final livestream
1. Loads qualifiers from the latest finished qualifying stream.
2. **1:00 intermission** (poll open) — vote on the web poll or in chat: `!vote XX`.
3. **Final — Last Flag Standing** among qualifiers.
4. **New rule:** when a country falls through the hole, it is **eliminated** and the round **resets** with the remaining countries, until one remains.

## Viewer pages (GitHub Pages)

| Page | URL |
|------|-----|
| Arena | https://yung1022.github.io/Flagbattle/ |
| Rankings history | https://yung1022.github.io/Flagbattle/rankings.html |
| Final poll | https://yung1022.github.io/Flagbattle/poll.html |
| Mobile go-live | https://yung1022.github.io/Flagbattle/control/ |

Stream ranking history is stored in [`data/rankings.json`](data/rankings.json) and published with Pages after each go-live.

Battle sheet: qualifying columns show **Q** / **nq**; Final columns show place / **nq**. Points only from Finals.

### Chat voting (Final)

Viewers can vote in YouTube live chat:

```
!vote us
```

Replies:
- `{Channel name} voted United States successfully`
- `{Channel name} country does not exist.`

### How polls work for viewers

1. Go-live starts a **Cloudflare quick tunnel** to the stream API.
2. Poll + rankings links are **posted to YouTube live chat** (pin manually in Studio — the API cannot pin).
3. Votes hit the tunnel (web or `!vote`); rankings/poll snapshots are mirrored into `data/` for history.

## Local run

```bash
node server.mjs
```

Open `http://localhost:5173` — QR/links still use GitHub Pages by default.

### Auto-stream

```bash
# Qualifying
PUBLIC_SITE=https://yung1022.github.io/Flagbattle npm run go-live --prefix stream -- --mode qualifying

# Final (after a qualifying run has saved results)
PUBLIC_SITE=https://yung1022.github.io/Flagbattle npm run go-live --prefix stream -- --mode final
```

## Mobile / cloud stream

See [`control/`](control/) and [`stream/`](stream/). Repo Action secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- Optional `GH_PAT` (contents write) for data commits that retrigger Pages

### Trigger go-live from your own cronjob

GitHub’s scheduled cron is often delayed, so this workflow is **`workflow_dispatch` only**. Call it from your server cron. **You must set `mode`.**

**1. Create a GitHub PAT** with permission to run Actions:
- Fine-grained: Actions **Read and write** on `yung1022/Flagbattle`, or
- Classic: `repo` + `workflow`

**2. Cron examples**

```bash
# Qualifying (e.g. every 4 hours)
curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_PAT" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/yung1022/Flagbattle/actions/workflows/go-live.yml/dispatches \
  -d '{
    "ref": "main",
    "inputs": {
      "mode": "qualifying",
      "privacy": "public",
      "duration_minutes": "40",
      "demo_seconds": ""
    }
  }'

# Final (schedule after a qualifying run, e.g. +45 minutes)
curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_PAT" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/yung1022/Flagbattle/actions/workflows/go-live.yml/dispatches \
  -d '{
    "ref": "main",
    "inputs": {
      "mode": "final",
      "privacy": "public",
      "duration_minutes": "30",
      "demo_seconds": ""
    }
  }'
```

**Inputs**

| Input | Default | Meaning |
|-------|---------|---------|
| `mode` | `qualifying` | **`qualifying`** or **`final`** (required for cron) |
| `privacy` | `public` | `public` / `unlisted` / `private` |
| `duration_minutes` | `40` | Kill the Actions runner after N minutes |
| `demo_seconds` | `""` | Leave empty for full length; set e.g. `"120"` for short tests |

**Or** Actions UI → **Go Live — FLAG BATTLE** → **Run workflow** with `mode` set.
