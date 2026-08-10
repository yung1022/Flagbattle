# FLAG BATTLE

Vertical **9:16** all-country flag battle for YouTube Shorts livestreams.

**Public site:** [yung1022.github.io/Flagbattle](https://yung1022.github.io/Flagbattle)

## Rules

Opening, Main, and Alien Invasion run in **one livestream**.

### Unified livestream (~4 hours)
1. **Opening (15:00)** — all flags, smaller hole (Sprint-like). Typing a country **spawns = votes**. Every **5 votes** grows a big flag. Round wins are unscored.
2. **Main (~3h30–3h45)** — HP bars + collision attacks. Last standing earns **+1 Main point** and a full-screen rank reveal, then the field resets. Random events every 2–5 min (each lasts 30s): **saw**, **black hole**, **catch**. Chat can still spawn/revive.
3. **Alien Invasion (~20 min)** — hole sealed; aliens attack flags (pressure round). **Champion = most Main points** (earlier first point wins ties) — not Invasion last standing.
4. **Season ranking** — Final place scores **50→1** points (plus poll bonus); Main points order fills the final board. Full-screen rank reveal only on Main last-standing points.
5. Vote/spawn anytime: type a country or `!vote XX` in chat / web poll.

## Viewer pages (GitHub Pages)

| Page | URL |
|------|-----|
| Arena | https://yung1022.github.io/Flagbattle/ |
| Rankings history | https://yung1022.github.io/Flagbattle/rankings.html |
| Predictions | https://yung1022.github.io/Flagbattle/predictions.html |
| Final poll | https://yung1022.github.io/Flagbattle/poll.html |
| Mobile go-live | https://yung1022.github.io/Flagbattle/control/ |

### Predictions (Google)

Viewers sign in with Google on [`predictions.html`](predictions.html), pick **5 countries** into win slots (**100 / 50 / 25 / 15 / 10**), and earn **+5** per pick that qualifies. Selecting is open **after the Final ends** until the next Qualifying starts. The page shows **current** and **next** selecting session times.

Set a **Google Web Client ID** (OAuth → Web application) with authorized JavaScript origin `https://yung1022.github.io` in [`data/predictions-config.json`](data/predictions-config.json) (`googleClientId`), or env `GOOGLE_PREDICTIONS_CLIENT_ID`. Only the site owner configures this — viewers cannot change it on the page.

Stream ranking history is stored in [`data/rankings.json`](data/rankings.json) and published with Pages after each go-live.

Battle sheet: each battle is one column (qualifying + Final paired). Finalists show Final place; non-qualifiers are ranked by average place across all qualifying rounds. <strong>Q</strong> only while waiting for that battle’s Final. Points only from Finals.

Control hub Highlights also offers a **landscape full-rankings video**: every country revealed one-by-one (last→#1) with 5s national anthem each, plus avg qualifying place. Encodes faster than realtime via WebCodecs.

### Chat voting — Nightbot + bare country names

**Nightbot can only trigger on a command name** (e.g. `!vote`). It cannot run a single regex that matches every country someone types in chat.

#### If chatters type `!vote …`
1. Join Nightbot: https://nightbot.tv  
2. Set **`NIGHTBOT_TOKEN`** (OAuth with `commands` scope) in `stream/.env` / Action secrets.  
   Go-live creates/updates `!vote` automatically.  
3. Viewers type:

```
!vote Japan
!vote jp
!vote go United States
```

Manual command (if no token), after each go-live:

```
!commands add !vote $(urlfetch https://YOUR-TUNNEL.trycloudflare.com/api/poll/vote?code=$(urlencode $(query))&voter=$(urlencode $(user))&format=text)
```

#### If chatters only type the country (no `!vote`)
Nightbot alone **cannot** match every country name with one command. Go-live enables a chat listener (`CHAT_VOTE=1`) that reads Live Chat via **Innertube** (the same path youtube.com uses — **no Data API list quota**):

1. Messages like `Japan`, `Brazil`, or `us` count as votes (same as `!vote Japan`). Vote as many times as you want — each vote adds to the tally. More votes → more **Shoutout Zone** features on stream.
2. Nightbot `!vote` still works as a backup when `NIGHTBOT_TOKEN` is set.
3. Set `CHAT_VOTE=0` to disable the listener and rely on `!vote` / web poll only.
4. Optional: `CHAT_VOTE_SOURCE=api` forces the old `liveChatMessages.list` path (burns quota). `CHAT_VOTE_REPLIES=0` skips bot chat replies (those still use Data API insert units).

Optional Nightbot workaround for a few popular countries: add a **command named exactly like the country** (no `!`, no spaces — Nightbot command names cannot contain spaces):

```
!commands add Japan $(urlfetch https://YOUR-TUNNEL…/api/poll/vote?code=jp&voter=$(urlencode $(user))&format=text)
!commands add Brazil $(urlfetch https://YOUR-TUNNEL…/api/poll/vote?code=br&voter=$(urlencode $(user))&format=text)
```

That only covers those exact single-word triggers. Prefer `CHAT_VOTE` for everyone typing bare country names (including `United States`).

Web poll still works either way.

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

The GitHub Action always starts a **full battle** (Opening → Main → Alien Invasion in one livestream).
Optional `--mode final` remains for local recovery of a Final-only run.

Livestream titles auto-format as **`FLAG BATTLE - DD/MM/YYYY #N`** (and rotating variations for the Opening → Main → Invasion format). `#N` is the stream number that day and resets at midnight (`STREAM_TITLE_TZ`, default UTC). Override with `YT_TITLE` only if you need a fixed title.

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
