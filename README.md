# FLAG BATTLE

Vertical **9:16** all-country flag battle built for YouTube Shorts livestreams.

## How it works

1. **Qualifying (30 minutes)** — All countries fight in the arena. Reach enough battle points to lock a Final slot. The top board shows **QUALIFIED FOR FINAL**.
2. **Last Flag Standing** — Finalists battle until one remains. The top board switches to **FLAGS STANDING**.

Default finalist slots: **32**.

## Run locally

Serve the folder (modules + flag CDN need HTTP):

```bash
npx --yes serve -l 5173 .
```

Open `http://localhost:5173`.

## Stream URLs

| Mode | URL |
|------|-----|
| Host controls | `/` |
| OBS / clean stream | `/?stream=1&autostart=1` |
| Fast demo (45s qualifying) | `/?demo=45` |
| Demo + stream | `/?demo=45&stream=1&autostart=1` |

OBS: Browser Source → width **1080**, height **1920**, URL with `stream=1`.

## Thumbnail

YouTube Shorts thumbnail: [`assets/thumbnail.png`](assets/thumbnail.png)

## Stack

- Vanilla HTML / CSS / JS (ES modules)
- Flags from [flagcdn.com](https://flagcdn.com) (all UN members + Vatican City)
