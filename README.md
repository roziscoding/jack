# jack

A self-hosted bridge that exposes your media library as a **Torznab indexer**
for Radarr/Sonarr and shares availability **peer-to-peer** with other jack
instances. It can auto-register itself in your \*arr apps and drop `.torrent`
files into a blackhole directory for your download client to pick up.

Built with [Bun](https://bun.com) and [Hono](https://hono.dev).

## How it works

- **Sources** — where jack learns what media exists (e.g. your Jellyfin).
- **Peers** — other jack instances you share availability with.
- **Destinations** — Radarr/Sonarr that jack registers itself into as a
  Torznab indexer and feeds results to.
- **Blackhole** — watches a directory for `.torrent` files and moves finished
  downloads into your library.

## Requirements

- [Bun](https://bun.com) `1.3.14` (pinned in `mise.toml`), **or** Docker.
- A config file (`config.jsonc`). A documented template lives at
  [`examples/config.jsonc`](examples/config.jsonc).

## Quick start (Docker)

From a clone of this repo:

```bash
# 1. Create your config from the template
mkdir -p config
cp examples/config.jsonc config/config.jsonc
$EDITOR config/config.jsonc        # fill in your servers (see below)

# 2. Build and run
docker compose -f examples/docker-compose.yml up -d --build

# 3. Watch the logs
docker compose -f examples/docker-compose.yml logs -f
```

You should see `Server listening` and, if you configured destinations,
`Registered Jack as Torznab indexer` lines.

The compose file mounts three host paths — adjust them for your setup:

| Mount | Purpose | Must match in `config.jsonc` |
| --- | --- | --- |
| `./config` → `/config` | App config | — |
| `${MEDIA_PATH:-./data/media}` → `/data/media` | Media library | `jack.mediaPath` |
| `${TORRENTS_PATH:-./data/torrents}` → `/data/torrents` | Blackhole dirs | `downloads.watchPath`, `downloads.completedPath` |

> **Networking:** if Jellyfin/Radarr/Sonarr run in their own Docker network,
> uncomment the `networks:` block in the compose file so jack can reach them by
> container name (and set `jack.baseUrl` to something they can resolve, e.g.
> `http://jack:3000`). Otherwise use the host IP.

## Configuration

Copy [`examples/config.jsonc`](examples/config.jsonc) and edit. All top-level
blocks except `servers` are optional — start with only what you have.

```jsonc
{
  "jack": {
    "baseUrl": "http://jack:3000",      // reachable from your *arr apps
    "apiKey": "a-long-random-string",
    "mediaPath": "/data/media"          // path INSIDE the container
  },
  "indexer": { "priority": 1, "autoRegister": true },
  "downloads": {
    "watchPath": "/data/torrents/watch",
    "completedPath": "/data/torrents/completed"
  },
  "servers": {
    "sources": [
      { "type": "jellyfin", "url": "http://jellyfin:8096", "apiKey": "..." }
    ],
    "peers": [
      { "name": "friend", "url": "https://their-jack.example.com", "apiKey": "..." }
    ],
    "destinations": [
      { "type": "radarr", "url": "http://radarr:7878", "apiKey": "<32 hex chars>" },
      { "type": "sonarr", "url": "http://sonarr:8989", "apiKey": "<32 hex chars>" }
    ]
  }
}
```

Notes:

- `destinations[].apiKey` must be the \*arr API key — **exactly 32 hex
  characters** (Radarr/Sonarr → Settings → General).
- If the config file is missing, jack creates a default empty one on startup.

### Environment variables

| Var | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `ENVIRONMENT` | `development` | `production` switches logs to JSON (no pretty-print) |
| `APP_CONFIG_PATH` | `/config/config.jsonc` | Path to the config file |

## Running without Docker

```bash
bun install

APP_CONFIG_PATH=./config/config.jsonc \
ENVIRONMENT=production \
PORT=3000 \
bun apps/backend/src/index.ts
```

For local development with hot reload:

```bash
mise run dev     # bun --cwd apps/backend --hot src/index.ts
```

## Development

```bash
bun test         # run tests
mise run lint    # lint
mise run lint:fix
```

## Project layout

```
apps/backend       # the Hono server (Torznab, peer API, blackhole watcher)
packages/schemas   # shared Zod schemas + generated Jellyfin client
examples/          # docker-compose.yml + config.jsonc template
Dockerfile         # multi-stage production image
```
