---
description: Manage jack servers, peers, API keys, downloads, catalog requests, and logs from the self-hosted web management console.
---

# Management UI

jack ships with a web console — the **management UI** — so you can run your
instance without hand-editing `config.jsonc`. With the
[Getting started](/guide/getting-started) compose file it runs as the
`jack-ui` service at **http://localhost:3000**, and it's the easiest way to
operate jack day to day:

- **Overview** — your configured servers and peers, and whether each one
  initialized cleanly.
- **Catalog** — browse everything your peers share, and request titles into
  your library.
- **Downloads** — inspect, cancel, retry, and delete in-flight or finished
  grabs.
- **Peers** and **Servers** — add, edit, and remove your friends and your
  Radarr/Sonarr connectors.
- **Settings → Downloads** — the whole
  [`downloads`](/reference/configuration#downloads) block: where finished files
  land, how many transfers run at once, whether jack drops its copy after an
  import, and the retry and import-watcher tuning.
- **API keys** — issue and revoke the keys you hand to peers.
- **Logs** — live-tail the backend's logs.

Don't want it? Delete the `jack-ui` service and the backend's
`JACK_MANAGEMENT_KEY` line to run jack headless.

## Access control

The UI supports two auth modes, depending on where the management key comes
from:

1. **Injected — feels authless.** Set `JACK_MANAGEMENT_KEY` in the UI's env;
   the compose file wires this for you. The UI adds the key on every request
   and the browser is never prompted — put a proxy such as Cloudflare Access
   or Traefik forward-auth in front of it to gate access.
2. **Cookie prompt.** Leave `JACK_MANAGEMENT_KEY` unset. The browser is
   prompted for the key once; it's validated against the management API and
   stored in a sealed `HttpOnly` cookie. Set `JACK_SESSION_KEY` — at least 32
   characters — in production to seal that cookie.

## How it works

The UI is a Nuxt **backend-for-frontend**: a small server that serves the
browser app and proxies every call it makes.

Nothing management-related is ever exposed to your browser directly. The
browser only talks to the BFF; the BFF forwards each request to jack's
[management API](#management-api) and attaches the `X-Management-Key`
credential server-side — either injected from its environment or unsealed from
the session cookie, depending on the [access-control mode](#access-control).
The browser never holds the key in plain text.

The UI talks *only* to the management API. The public peer/Torznab port is a
separate listener the UI never touches.

See [`apps/ui/README.md`](https://github.com/roziscoding/jack/blob/main/apps/ui/README.md)
for the full UI configuration reference.

## Management API

The UI's backing API — the **management API** — is a separate listener on its
own port (`MANAGEMENT_PORT`, default `5226`), started only when
`JACK_MANAGEMENT_KEY` is set. It can read and rewrite your whole config,
including connector credentials, so treat it as an admin socket:

Anyone who can reach it with the key controls your jack — and can read the
config, redirect downloads, or point your *arr connectors elsewhere. A single
bug in its auth check would hand that to anyone who can reach it at all.

That's why the default compose setup is the way it is — and why you shouldn't
change it: it publishes no host port for `5226`, so the management API is
reachable only from inside the Docker network, which is exactly the set of
things that need it — the UI's BFF. If you want remote management, expose the
**UI** behind an authenticating proxy and let it do the talking.

If you truly need to expose the management API itself, don't let its key be
the only lock: put an independent auth layer in front — Cloudflare Access,
Authelia, Traefik forward-auth, or similar — so a bug in jack's auth isn't a
bug in *your* perimeter. No code is immune to bugs; defense in depth is the
point.
