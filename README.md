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
| Predictions | https://yung1022.github.io/Flagbattle/predictions.html |
| Final poll | https://yung1022.github.io/Flagbattle/poll.html |
| Mobile go-live | https://yung1022.github.io/Flagbattle/control/ |

### Predictions (Google)

Viewers sign in with Google on [`predictions.html`](predictions.html), pick **5 countries** into win slots (**100 / 50 / 25 / 15 / 10**), and earn **+5** per pick that qualifies. Selecting is open **before qualifying starts** and again **after the Final ends** (until the next qualifying). The page shows **current** and **next** selecting session times.

Set a **Google Web Client ID** (OAuth → Web application) with authorized JavaScript origin `https://yung1022.github.io` in [`data/predictions-config.json`](data/predictions-config.json) (`googleClientId`), or env `GOOGLE_PREDICTIONS_CLIENT_ID`. Only the site owner configures this — viewers cannot change it on the page.

Stream ranking history is stored in [`data/rankings.json`](data/rankings.json) and published with Pages after each go-live.

Battle sheet: each battle is one column (qualifying + Final paired). Finalists show Final place; non-qualifiers are ranked by average place across all qualifying rounds. <strong>Q</strong> only while waiting for that battle’s Final. Points only from Finals.

Control hub Highlights also offers a **landscape full-rankings video**: every country revealed one-by-one (last→#1) with 5s national anthem each, plus avg qualifying place. Encodes faster than realtime via WebCodecs.

### Chat voting (Final) — Nightbot

YouTube Data API chat polling is **off** by default (quota). Use **Nightbot**:

1. Join Nightbot to your YouTube channel: https://nightbot.tv  
2. Add a repo / `stream/.env` secret **`NIGHTBOT_TOKEN`** (Nightbot OAuth token with `commands` scope).  
   Go-live will create/update `!vote` to hit the live tunnel automatically.  
3. Viewers type:

```
!vote us
```

Replies (from Nightbot):
- `{name} voted United States successfully`
- `{name} country does not exist.`
- `{name} poll is not open yet.`

Without a token, add the command yourself after each go-live (tunnel URL is printed in the Action log):

```
!commands add !vote $(urlfetch https://YOUR-TUNNEL.trycloudflare.com/api/poll/vote?code=$(query)&voter=$(user)&format=text)
```

Web poll still works. To re-enable the old YouTube API vote loop: `CHAT_VOTE=1`.

### How polls work for viewers

1. Go-live starts a **Cloudflare quick tunnel** to the stream API.
2. Poll + rankings links are **posted to YouTube live chat** (pin manually in Studio — the API cannot pin).
3. Votes hit the tunnel (web poll or Nightbot `!vote`); rankings/poll snapshots are mirrored into `data/` for history.

## Local run

```bash
node server.mjs
```

Open `http://localhost:5173` — QR/links still use GitHub Pages by default.

### Auto-stream

```bash
PUBLIC_SITE=https://yung1022.github.io/Flagbattle npm run go-live --prefix stream
# Optional: force a mode locally with --mode qualifying|final
```

The GitHub Action picks the mode automatically from `data/rankings.json`:
- last finished stream was **qualifying** (with qualifiers) → next is **final**
- otherwise → **qualifying**

## Mobile / cloud stream

See [`control/`](control/) and [`stream/`](stream/). Repo Action secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- Optional `NIGHTBOT_TOKEN` — auto-points Nightbot `!vote` at each stream’s tunnel
- Optional `GH_PAT` (contents write) for data commits that retrigger Pages

### Trigger go-live from your own cronjob

GitHub’s scheduled cron is often delayed, so this workflow is **`workflow_dispatch` only**. Call it from your server cron — **do not pass `mode`**; the workflow chooses it.

**1. Auth — GitHub PAT** with permission to run Actions:
- Fine-grained: Actions **Read and write** on `yung1022/Flagbattle`, or
- Classic: `repo` + `workflow`

**2. Request**

- **Method:** `POST`
- **URL:** `https://api.github.com/repos/yung1022/Flagbattle/actions/workflows/go-live.yml/dispatches`
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer YOUR_GITHUB_PAT`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Body:**
```json
{
  "ref": "main",
  "inputs": {
    "privacy": "public",
    "duration_minutes": "40",
    "demo_seconds": ""
  }
}
```

**3. Cron example**

```bash
# crontab -e   →   e.g. every 2 hours
curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_PAT" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/yung1022/Flagbattle/actions/workflows/go-live.yml/dispatches \
  -d '{"ref":"main","inputs":{"privacy":"public","duration_minutes":"40","demo_seconds":""}}'
```

**Inputs (optional)**

| Input | Default | Meaning |
|-------|---------|---------|
| `privacy` | `public` | `public` / `unlisted` / `private` |
| `duration_minutes` | `40` | Kill the Actions runner after N minutes |
| `demo_seconds` | `""` | Leave empty for full length; set e.g. `"120"` for short tests |

**Or** Actions UI → **Go Live — FLAG BATTLE** → **Run workflow**.
