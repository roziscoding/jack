---
description: Run and develop jack directly with Bun without Docker, including local commands, project layout, tests, and generated API clients.
---

# Running without Docker

jack is a [Bun](https://bun.com) app, so all you need is a Bun install and a
clone of the repo:

```bash
bun install

APP_CONFIG_PATH=./config/config.jsonc \
ENVIRONMENT=production \
PORT=5225 \
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

API types for external services are generated from OpenAPI specs:

```bash
mise run clients   # regenerate packages/schemas/src/generated
```

## Project layout

```
apps/backend            # the Hono server (Torznab, peer API, qBittorrent API)
apps/backend/Dockerfile # backend production image (build context = repo root)
apps/ui                 # the management console (Nuxt App)
apps/ui/Dockerfile      # management UI image (build context = repo root)
packages/schemas        # generated Radarr/Sonarr API types
examples/               # docker-compose.yml + config.jsonc template
```
