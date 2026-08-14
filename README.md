# Stremio Jellyfin

A self-hosted [Stremio](https://stremio.com) addon that turns your [Jellyfin](https://jellyfin.org) library into a first-class Stremio catalog — with movies, TV shows, search, genre browsing, and direct playback from your own server.

**Multi-user by design:** every Jellyfin setup gets its own tokenized install URL, so you can share access with friends and family without ever exposing your Jellyfin URL or API key.

## Features

- **Multi-config, per-user install links** – each Jellyfin setup (URL + API key) is encoded into a self-contained token in the install URL. No server-side accounts, no shared secrets in URLs.
- **Public setup page** (`/configure`) – anyone can generate an install link for their own Jellyfin server.
- **Protected manage page** (`/manage`) – password-protected (cookie-based login) overview of all registered setups with their install links and live status.
- **Rich stream cards** – every stream includes resolution, video/audio codecs, file size, bitrate, and filename; episodes show `S01E01`-style labels.
- **Movies & Shows catalogs, genre browsing, and global search** powered by the Jellyfin API.
- **Direct playback** by default; optional Jellyfin-side transcoding fallback.
- **Secure image proxying** – posters and backdrops are proxied through the addon so your API key never appears in URLs.
- **Docker ready** – Alpine image, config persisted in a named volume, runs as non-root.

## How it works

1. The addon stores Jellyfin credentials inside the install URL itself as `base64url(JSON({ jellyfinUrl, jellyfinApiKey }))`.
2. Stremio requests `https://addon.example.com/<token>/manifest.json`, and the addon resolves the token back to a Jellyfin setup.
3. Each token yields a **stable, unique addon instance** — no server-side per-user state required.

Because credentials live in the URL, the addon never keeps anyone else's setup on the server and cannot leak other users' data.

## Requirements

- Docker + Docker Compose (recommended), or Node.js 18+
- A running Jellyfin server (publicly reachable from the addon host)
- A Jellyfin **API key**: Jellyfin Dashboard → **Advanced** → **API Keys** → *Add API key*

## Quick start (Docker, recommended)

1. Clone the repo:

   ```bash
   git clone https://github.com/<you>/stremio-jellyfin.git
   cd stremio-jellyfin
   ```

2. Set a password for the manage page (generate one: `openssl rand -hex 16`) and edit `docker-compose.yml`:

   ```yaml
   services:
     stremio-jellyfin:
       build:
         context: .
       image: stremio-jellyfin:latest
       container_name: stremio-jellyfin
       restart: unless-stopped
       ports:
         - "7000:7000"
       environment:
         - PORT=7000
         # Persistent config lives in the named volume below; no host file needed.
         - CONFIG_PATH=/app/config/config.json
         # Password for the /manage page and setup APIs (recommended for any
         # public deployment). Generate one with: openssl rand -hex 16
         - MANAGE_KEY=your-strong-random-key
         # Optional: bootstrap a single Jellyfin setup from environment variables
         # instead of the web UI (takes precedence over config.json at boot).
         # - JELLYFIN_URL=https://media.example.com
         # - JELLYFIN_API_KEY=your-jellyfin-api-key
       volumes:
         - config_data:/app/config

   volumes:
     config_data:
   ```

3. Start the addon:

   ```bash
   docker compose up -d --build
   ```

4. Open **http://your-host:7000/configure**, enter your Jellyfin URL and API key, and install the generated link in Stremio (**Addons → Install from URL**). The link works from any device that can reach your host.

5. Open **http://your-host:7000/manage** and log in with your `MANAGE_KEY` to see every registered setup and its install link.

### Optional: bootstrap via environment variables

Skip the web UI for a single setup by setting `JELLYFIN_URL` and `JELLYFIN_API_KEY` in the compose file — they take precedence over `config.json` at boot.

## Quick start (Node)

```bash
npm install
npm start          # listens on 7000 by default
```

Open http://localhost:7000 and follow steps 4–5 above (use `http://localhost:7000` instead of your host URL).

## Configuration

All settings are optional and come from environment variables, with `config.json` as fallback.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `7000` | HTTP port the addon listens on |
| `CONFIG_PATH` | `./config.json` | Where persisted setups are stored |
| `MANAGE_KEY` | – | Password for `/manage` and the setup APIs (strongly recommended) |
| `JELLYFIN_URL` | – | Bootstrap a single setup at boot |
| `JELLYFIN_API_KEY` | – | Bootstrap API key (requires `JELLYFIN_URL`) |

`config.json` additionally supports `streamMode` (`direct` or `auto`), `pageSize`, and `cacheTtl`.

## Endpoints

| Path | Access | Purpose |
| --- | --- | --- |
| `/` | public | Redirects to `/configure` |
| `/configure` | public | Generate an install link for any Jellyfin server |
| `/manage` | `MANAGE_KEY` | All registered setups, statuses, install links |
| `/:token/manifest.json` | public | The Stremio addon manifest for a specific setup |
| `/:token/` | public | Per-user front page (catalog, search, stream list) |
| `/health` | public | Addon + Jellyfin connectivity status |
| `/api/login`, `/api/logout` | – | Manage-page cookie auth |

## Reverse proxy (nginx)

A production nginx config with automatic HTTP→HTTPS redirect, the large proxy buffers long install tokens need, and timeouts for long-running playback streams:

```nginx
server {
    listen 80;
    server_name addon.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name addon.example.com;

    ssl_certificate /etc/letsencrypt/live/addon.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/addon.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Install URLs contain long base64/json tokens — must not be truncated
        proxy_buffers 8 64k;
        proxy_buffer_size 64k;

        proxy_redirect default;

        # Long-running /Videos/.../stream requests
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Save it as `/etc/nginx/sites-available/stremio-jellyfin`, symlink it into `sites-enabled`, and get a certificate with `certbot --nginx -d addon.example.com` (replace the `server_name` and cert paths with your domain; a wildcard cert for your zone also works). The same file ships in the repo at [`deploy/nginx.conf`](deploy/nginx.conf).

## Troubleshooting

- **Catalog loads, streams don't play** – the Stremio device must reach Jellyfin directly; check the stream's `File` line in its card and your firewall.
- **Metadata is empty** – the addon host must be able to reach Jellyfin.
- **Install link too long for your reverse proxy** – raise the proxy buffer sizes (see above) and verify `proxy_request_buffering`/header limits on your proxy.
- **Everything slow or broken behind a proxy** – check `/health` first; it reports addon uptime and Jellyfin connectivity per setup.

## License

MIT