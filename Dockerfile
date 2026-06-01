# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app

# Copy only the manifests so this layer is cached unless deps change.
COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/schemas/package.json packages/schemas/package.json

RUN bun install --frozen-lockfile --production

# ---- generate: full install + generate the API clients (gitignored) ----
FROM oven/bun:1.3.14-alpine AS generate
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/schemas/package.json packages/schemas/package.json

# Full install here (openapi-ts is a devDependency).
RUN bun install --frozen-lockfile

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

# Config lives outside the image so it survives rebuilds.
VOLUME ["/config"]

# Hit the /ping endpoint to report container health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://localhost:${PORT}/ping" || exit 1

CMD ["bun", "apps/backend/src/index.ts"]
