# Stremio Jellyfin

A self-hosted [Stremio](https://stremio.com) / Nuvio addon that turns one or more [Jellyfin](https://jellyfin.org) servers into a first-class catalog — movies, shows, genres, search, and direct playback from your own media. Multi-user by design: every visitor can connect **their own** Jellyfin account and get a private install link, without exposing your server.

## Highlights

- **Short install links** — `https://your-addon/s/k7m2xw9pqr4t/manifest.json` carries **zero credentials**; hosts/tokens live in the addon's SQLite database.
- **Login with a regular Jellyfin account** (or guest) — the addon exchanges username/password for an access token via `/Users/AuthenticateByName`. Admin API keys still work. Passwords are never stored in links.
- **Merge multiple Jellyfin hosts into ONE link** — catalogs merge across servers, meta/stream/images fall through to whichever host owns the item.
- **Request missing content** — per-host integration with **Jellyseerr / Overseerr / Ombi**. Search a movie that's not on any host → Stremio shows a *📥 Request* stream → playing it submits the request server-side. Works with an admin API key **or** your request-app username/password.
- **Catalog toggles** — choose Movies / Shows / Genres per link.
- **Optional host hiding at play time** — flip "Proxy" on a setup and media bytes relay through the addon so clients never see the Jellyfin origin.
- **Secure image proxy** — posters/backdrops are proxied so API keys never appear in URLs.
- **SQLite storage** (`node:sqlite`, zero extra deps) with automatic migration from legacy `config.json`; JSON fallback on older runtimes.
- Auto-renew: when an access token is revoked, setups stored with an encrypted password re-authenticate transparently on 401.
- Docker-ready Alpine image with built-in container `HEALTHCHECK`.

## How it works

1. Open `/configure` on your addon host, enter your Jellyfin URL + account (or API key), optionally attach a request app, pick catalogs → hit **Generate**.
2. The addon verifies credentials, mints a random **short id**, stores the encrypted setup in SQLite, and hands you `https://your-addon/s/<id>/manifest.json`.
3. Install that link in Stremio/Nuvio. Catalog/meta/stream requests resolve against your stored setup; nothing sensitive ever appears in the URL.

Legacy self-contained token URLs (`/<base64url>/manifest.json`) keep working for old installs.

## Requirements

- Docker + Docker Compose (recommended) or Node.js ≥ 22.5
- A reachable Jellyfin server
- A Jellyfin account (regular user or guest works!) or an admin API key

## Quick start (Docker Compose)

`docker-compose.yml` ships preconfigured to pull the published image:

```yaml
services:
  stremio-jellyfin:
    image: ghcr.io/hcdbp24c3/stremio-jellyfin:latest
    container_name: stremio-jellyfin
    restart: unless-stopped
    ports:
      - "7000:7000"
    environment:
      - PORT=7000
      - CONFIG_PATH=/app/config/config.json
      # openssl rand -hex 16
      - MANAGE_KEY=change-me
      # Optional first-boot bootstrap:
      # - JELLYFIN_URL=https://media.example.com
      # - JELLYFIN_API_KEY=...            # or JELLYFIN_USERNAME / JELLYFIN_PASSWORD
    volumes:
      - config_data:/app/config

volumes:
  config_data:
```

```bash
docker compose up -d
```

Open **http://your-host:7000/configure**, connect your Jellyfin, copy the short link, add it in Stremio (**Addons → Install from URL**). Manage everything at **http://your-host:7000/manage** with your `MANAGE_KEY`.

## Quick start (docker run)

```bash
docker run -d \
  --name stremio-jellyfin \
  --restart unless-stopped \
  -p 7000:7000 \
  -e MANAGE_KEY=$(openssl rand -hex 16) \
  -v stremio-jellyfin-config:/app/config \
  ghcr.io/hcdbp24c3/stremio-jellyfin:latest
```

Add `-e JELLYFIN_URL=… -e JELLYFIN_API_KEY=…` (or `JELLYFIN_USERNAME`/`JELLYFIN_PASSWORD`) to bootstrap your first setup without touching the web UI.

## Run from source (Node)

```bash
npm install
npm start        # node --experimental-sqlite index.js — listens on :7000
```

## Configuration

Environment variables win over `config.json`; the setups database defaults to `<CONFIG_PATH dir>/setups.db`.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `7000` | HTTP listen port |
| `CONFIG_PATH` | `./config.json` | Legacy settings file (also migration source) |
| `DB_PATH` | `<config dir>/setups.db` | SQLite database file |
| `MANAGE_KEY` | – | Password for `/manage` + setup APIs (strongly recommended) |
| `JELLYFIN_URL` | – | First-boot bootstrap: server URL (store must be empty) |
| `JELLYFIN_API_KEY` | – | Bootstrap with an admin API key |
| `JELLYFIN_USERNAME` / `JELLYFIN_PASSWORD` | – | Bootstrap with a regular/guest account instead |
| `JELLYFIN_NAME` | `My Jellyfin` | Name for the bootstrapped setup |
| `PROXY_STREAMS` | off | Default ON/OFF of per-setup stream proxying (toggle later in `/manage`) |
| `MAX_PUBLIC_SETUPS` | `500` | Cap for setups minted via the public `/configure` page |
| `RATE_LIMIT_PER_MIN` | `60` | Per-IP limit on public POST endpoints |
| `ADDON_BASE_URL` | auto | Force the absolute base used in poster/stream URLs (behind odd proxies) |

Per-setup runtime toggles live in the admin UI and survive restarts (stored in SQLite): **stream proxy**, plus everything baked into each setup (hosts, request app, catalogs).

## Request apps (Jellyseerr / Overseerr / Ombi)

In `/configure`, expand **Request integration** on any host card:

- **API Key** — the app's admin key (`X-Api-Key` / `ApiKey` header).
- **Username / Password** — any regular account; the addon logs in once (`/api/v1/auth/local`, or Ombi `/api/v1/Token`), keeps only the session token, and sends requests as you. The password is never embedded in the link.

When a title exists on none of the merged hosts, Stremio lists a `📥 Request via <service>` stream. Playing it resolves IMDb→TMDB/TVDB ids via Cinemeta and submits the request in the background (duplicates count as success). Ombi TV requests use the TVDB id automatically.

## Endpoints

| Path | Access | Purpose |
| --- | --- | --- |
| `/configure` | public | Generate your own install link(s) |
| `/manage` | `MANAGE_KEY` | All stored setups, statuses, per-setup proxy toggle |
| `/s/<id>/manifest.json` | public | Short install manifest (no credentials in URL) |
| `/s/<id>` | public | Per-setup status page |
| `/<token>/manifest.json` | public | Legacy self-contained token URLs (still valid) |
| `/img/…`, `/p/…` | public | Image proxy / optional stream proxy |
| `/r/…` | public | Request placeholder player (fires the background request) |
| `/healthz` | public | Liveness — process up, ignores upstream state |
| `/health` | public | Deep readiness incl. per-setup Jellyfin reachability |
| `/api/setups` | public (capped + rate-limited) | Mint a new setup |
| `/api/check`, `/api/check-request` | public (rate-limited) | Verify Jellyfin / request-app credentials |
| `/api/configs[/…]` | `MANAGE_KEY` | CRUD setups |
| `/api/settings` | `MANAGE_KEY` | Global default + per-setup stream-proxy toggle |

## Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name addon.example.com;

    ssl_certificate     /etc/letsencrypt/live/addon.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/addon.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffers 8 64k;          # manifests can be long
        proxy_read_timeout 1h;        # long playback streams
        proxy_send_timeout 1h;
    }
}
```

The same file ships in [`deploy/nginx.conf`](deploy/nginx.conf). Behind Cloudflare or another proxy that rewrites Host, set `ADDON_BASE_URL` so poster/stream URLs stay absolute.

## Storage & migration

- Fresh installs create `<config dir>/setups.db` (WAL mode). Everything — hosts, encrypted passwords/session tokens, request-app tokens, catalog toggles, per-setup proxy flag — lives there.
- First boot with an existing legacy `config.json` imports `savedConfigs`/instances automatically, then clears those lists from the file. Back up the volume (`/app/config`) and you're done.

## Troubleshooting

- **Catalog loads, streams don't play** — clients must reach Jellyfin directly unless the setup has **Proxy** enabled; check the stream card's `File:` line.
- **Posters blank** — make sure you're on a recent image (posters are absolute URLs now) and, behind a rewriting proxy, that `ADDON_BASE_URL` matches the public origin.
- **`/manage` locked out** — reset `MANAGE_KEY`; note that rotating it invalidates previously encrypted passwords (links regenerate fine).
- **Everything slow/broken** — start at `/healthz` (process up?) then `/health` (which upstream is down?).

## License

MIT
