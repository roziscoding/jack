# @jack/ui — management console

A Nuxt 4 app that is also the **BFF** (backend-for-frontend) for jack's management
API. It serves the SPA and proxies every data call to the management API, injecting
the `X-Management-Key` so the browser never sees it.

It talks **only** to the management API (never the public peer API). The management
API exposes richer, UI-oriented endpoints (`/overview`, `/downloads`) on top of the
config CRUD (`/config/peers`, `/config/servers`).

## How it relates to the server

The jack backend starts its management API on `MANAGEMENT_PORT` (default `5226`)
**only when `MANAGEMENT_KEY` is set**. Point this UI at that port.

## Auth modes

Both are supported on one axis — where the key comes from:

1. **Injected (feels authless).** Set `JACK_MANAGEMENT_KEY` in the UI's own env.
   The BFF injects the header on every request; the browser is never prompted.
   Use this to delegate access control to a proxy (Cloudflare Access, Traefik
   forward-auth, …) — strictly safer than disabling the check, because the
   management API stays key-protected against anyone hitting the port directly.

2. **Cookie prompt.** Leave `JACK_MANAGEMENT_KEY` unset. The browser hits `/api/ping`,
   gets `needs-key`, and prompts. The key is validated against the management API and
   stored in an `HttpOnly` + `Secure` + `SameSite=Strict` sealed cookie. CSRF is
   closed by `SameSite=Strict` plus a same-origin check on the BFF.

`/api/ping` resolves to one of: `ok`, `needs-key`, `disabled` (management API
unreachable — server has no `MANAGEMENT_KEY`), or `error`.

## Environment

These map to Nuxt's `runtimeConfig` via the `JACK_` env prefix (set through
`runtimeConfig.nitro.envPrefix` in `nuxt.config.ts`, replacing Nitro's default
`NUXT_`). They are read at **runtime**, so the CI-built image picks them up when
the operator sets them at container-run time:

| Var | Default | Notes |
|---|---|---|
| `JACK_MANAGEMENT_API_URL` | `http://localhost:5226` | where the jack management API listens |
| `JACK_MANAGEMENT_KEY` | _(unset)_ | set → inject mode; unset → cookie-prompt mode |
| `JACK_SESSION_KEY` | dev-only fallback | **set in prod** (≥ 32 chars); secret that seals the cookie in cookie mode |

`Secure` on the cookie is driven by `X-Forwarded-Proto`, so it works behind a
reverse proxy terminating TLS.

## Develop

```sh
# from the repo root
mise run ui                    # http://localhost:3000
```

Run the backend with `MANAGEMENT_KEY` set first, then point the UI at it:

```sh
JACK_MANAGEMENT_API_URL=http://localhost:5226 \
JACK_MANAGEMENT_KEY=<your-key> \
mise run ui
```

## Build

```sh
bun run --cwd apps/ui build    # outputs .output/ (Nitro)
node apps/ui/.output/server/index.mjs
```
