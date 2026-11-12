# syntax=docker/dockerfile:1

# ---- development: install deps and copy the source, stopping before the build ----
# Used by `mise run dev` (target: development): Compose Watch syncs local edits
# into the copy below and `nuxt dev` hot-reloads. The build stage continues
# from here.
FROM oven/bun:1.4.4-alpine AS development
WORKDIR /app

# Copy only the manifests so this layer is cached unless deps change. The root
# package.json globs `apps/*`/`packages/*`, so every workspace manifest referenced
# by bun.lock must be present or --frozen-lockfile fails. We only need @jack/ui's
# deps, so --filter keeps the backend/schemas trees out of the install.
COPY package.json bun.lock ./
COPY apps/ui/package.json apps/ui/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY packages/schemas/package.json packages/schemas/package.json

# Full install — Nuxt needs its devDependencies (tailwind, vue-tsc, …) to build.
# @jack/ui's postinstall runs `nuxt prepare`; `nuxt build` below regenerates the
# real types from the actual source.
RUN bun install --frozen-lockfile --filter '@jack/ui'

COPY apps/ui ./apps/ui

EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/ui", "dev", "--host", "0.0.0.0", "--port", "3000"]

# ---- build: the Nuxt/Nitro server ----
FROM development AS build
# The version shown in the UI (CI passes the image version). Unset falls back to
# `dev`, since the build context has no .git to read tags from.
ARG APP_VERSION
RUN bun run --cwd apps/ui build

# ---- runtime: the self-contained Nitro output ----
FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    # `::` listens on IPv6 and IPv4 alike, so `localhost` (which resolves to ::1
    # first in this image) and 127.0.0.1 both reach the server. 0.0.0.0 would be
    # IPv4 only.
    HOST=:: \
    # Where the jack management API listens. In compose this resolves to the
    # backend service by container name; override per deployment. Read at RUNTIME
    # (the `JACK_` prefix maps to Nuxt runtimeConfig — see apps/ui/nuxt.config.ts),
    # so the CI-built image picks it up when the operator sets it at run time.
    JACK_MANAGEMENT_API_URL=http://jack:5226

# `nuxt build` emits a self-contained server (it bundles its own node_modules)
# under .output, so the runtime image needs nothing from the workspace but that dir.
COPY --from=build /app/apps/ui/.output ./.output

# Nitro's server listens on $PORT (overridable at run time); EXPOSE tracks it.
EXPOSE ${PORT}

# Run as the image's non-root `bun` user (uid/gid 1000), matching the backend image.
USER bun

# /api/ping always answers 200 (ok | needs-key | disabled | error) once the
# server is up, so it's a clean liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://localhost:${PORT}/api/ping" || exit 1

CMD ["bun", ".output/server/index.mjs"]
