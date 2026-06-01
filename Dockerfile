# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app

# Copy only the manifests so this layer is cached unless deps change.
COPY package.json bun.lock ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/schemas/package.json packages/schemas/package.json

RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV ENVIRONMENT=production \
    NODE_ENV=production \
    PORT=3000 \
    APP_CONFIG_PATH=/config/config.jsonc

COPY package.json bun.lock ./

# Source first, then overlay the per-workspace node_modules from the deps
# stage. Bun installs into each workspace (no hoisting), and
# apps/backend/node_modules/@jack/schemas is a symlink into packages/schemas.
COPY packages/schemas ./packages/schemas
COPY apps/backend ./apps/backend
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/schemas/node_modules ./packages/schemas/node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules

EXPOSE 3000

# Config lives outside the image so it survives rebuilds.
VOLUME ["/config"]

CMD ["bun", "apps/backend/src/index.ts"]
