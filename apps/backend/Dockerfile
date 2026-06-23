# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app

# Copy only the manifests so this layer is cached unless deps change.
# The root package.json globs `apps/*`, so every workspace manifest referenced
# by bun.lock must be present or --frozen-lockfile fails. apps/ui (Nuxt) is part
# of the workspace but not needed for the backend image, so we copy its manifest
# to satisfy the lockfile and use --filter to skip installing its deps.
COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY packages/schemas/package.json packages/schemas/package.json

RUN bun install --frozen-lockfile --production \
    --filter '@jack/backend' --filter '@jack/schemas'

# ---- generate: full install + generate the API clients (gitignored) ----
FROM oven/bun:1.3.14-alpine AS generate
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY packages/schemas/package.json packages/schemas/package.json

# Full install here (openapi-ts is a devDependency). apps/ui's manifest is
# copied to satisfy the frozen lockfile; --filter keeps Nuxt out of the install.
RUN bun install --frozen-lockfile \
    --filter '@jack/backend' --filter '@jack/schemas'

COPY packages/schemas ./packages/schemas
RUN bun run --cwd packages/schemas openapi-ts

# ---- runtime ----
FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV ENVIRONMENT=production \
    NODE_ENV=production \
    PORT=5225 \
    APP_CONFIG_PATH=/config/config.jsonc

COPY package.json bun.lock ./

# Source first, then overlay the per-workspace node_modules from the deps
# stage. Bun installs into each workspace (no hoisting), and
# apps/backend/node_modules/@jack/schemas is a symlink into packages/schemas.
COPY packages/schemas ./packages/schemas
COPY apps/backend ./apps/backend
# Generated API clients are gitignored, so pull them from the generate stage.
COPY --from=generate /app/packages/schemas/src/generated ./packages/schemas/src/generated
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/schemas/node_modules ./packages/schemas/node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules

EXPOSE 5225

# Pre-create the config dir owned by the runtime user so jack can write the
# default config on first boot even when /config is a fresh named/anonymous
# volume. (Must come before VOLUME so the volume inherits the ownership.)
RUN mkdir -p /config && chown bun:bun /config

# Config lives outside the image so it survives rebuilds.
VOLUME ["/config"]

# Run as the image's non-root `bun` user (uid/gid 1000). This matches the
# PUID/PGID the *arr / linuxserver.io images default to, so files jack writes
# (e.g. finished downloads in the completed folder) are owned by the
# same user that imports them. Bind-mounted /config and download folders must
# therefore be readable/writable by uid 1000.
USER bun

# Hit the /ping endpoint to report container health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://localhost:${PORT}/ping" || exit 1

CMD ["bun", "apps/backend/src/index.ts"]
