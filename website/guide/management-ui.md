---
description: Manage jack servers, peers, API keys, downloads, catalog requests, and logs from the self-hosted web management console, with live updates over Server-Sent Events.
---

# Management UI

jack ships with a web console, the **management UI**, so you can run your
instance without hand-editing `config.jsonc`. With the
[Getting started](/guide/getting-started) compose file it runs as the
`jack-ui` service at **http://localhost:3000**, and it's the easiest way to
operate jack day to day:

- ***Overview***: your configured servers and peers, and whether each one
  initialized cleanly, with transfer activity updating live.
- ***Catalog***: browse everything your peers share, and request titles into
  your library.
- ***Downloads***: inspect, cancel, retry, and delete in-flight or finished
  grabs, updating live as they progress.
- ***Peers*** and ***Servers***: add, edit, and remove your friends and your
  Radarr/Sonarr connectors.
- ***Settings -> Downloads***: the whole
  [`downloads`](/reference/configuration#downloads) block, covering where
  finished files land, how many transfers run at once, whether jack drops its
  copy after an import, and the retry and import-watcher tuning.
- ***Settings -> Quick linking***: how peers reach this instance, plus the
  buttons that generate and import [quick links](/guide/quick-links).
- ***API keys***: issue and revoke the keys you hand to peers.
- ***Logs***: live-tail the backend's logs.

Don't want it? Delete the `jack-ui` service and the backend's
`JACK_MANAGEMENT_KEY` line to run jack headless.

## Settings -> Downloads

The whole [`downloads`](/reference/configuration#downloads) block is editable
here, so there's no reason to hand-edit `config.jsonc` for it:

- The settings you actually choose sit at the top: ***Completed folder***,
  ***simultaneous transfers***, and the
  **[drop imported files](/reference/configuration#downloads-unlinkimportedfiles)**
  switch.
- ***Transfer retries*** and ***import watcher*** tuning are collapsed below,
  each labelled with how many of its values you've moved off jack's defaults.

Every field's placeholder is jack's default, and **clearing a field means "use
the default"**: jack drops the key from the config file rather than storing a
blank. `completedPath` is the exception, since it has no default and so can't be
cleared. If your config has no `downloads` block at all, the page offers to set
one up.

One ***Save*** covers the form and only lights up once something changed;
***Revert*** discards your edits. `unlinkImportedFiles` takes effect the moment
you save. **Every other key here is read at startup, so restart jack** to apply
it.

## Settings -> Quick linking

This section holds the [`jack.external`](/reference/configuration#jack-external)
profile, meaning the instance name, external URL, and any proxy headers a peer
needs to reach you, along with the two buttons that use it:

- ***Generate quick link*** issues a fresh peer API key and encodes it, together
  with the profile, into a single shareable string. It's enabled only once the
  profile is saved, and the link is revealed exactly once.
- ***Add via quick link*** decodes a link a friend sent you and opens the
  ***Add peer*** form prefilled, for you to review before saving.

Treat a generated link as a credential. [Quick links](/guide/quick-links) covers
the full workflow and how to revoke one.

## Access control

The UI supports two auth modes, depending on where the management key comes
from:

1. **Injected**, which feels authless. Set `JACK_MANAGEMENT_KEY` in the UI's
   env; the compose file wires this for you. The UI adds the key on every
   request and the browser is never prompted, so put a proxy such as Cloudflare
   Access or Traefik forward-auth in front of it to gate access.
2. **Cookie prompt.** Leave `JACK_MANAGEMENT_KEY` unset. The browser is
   prompted for the key once; it's validated against the management API and
   stored in a sealed `HttpOnly` cookie. Set `JACK_SESSION_KEY` in production,
   at least 32 characters, to seal that cookie.

## How it works

The UI is a Nuxt **backend-for-frontend**: a small server that serves the
browser app and proxies every call it makes.

Nothing management-related is ever exposed to your browser directly. The
browser only talks to the BFF; the BFF forwards each request to jack's
[management API](#management-api) and attaches the `X-Management-Key`
credential server-side, either injected from its environment or unsealed from
the session cookie, depending on the [access-control mode](#access-control).
The browser never holds the key in plain text.

The UI talks *only* to the management API. The public peer/Torznab port is a
separate listener the UI never touches.

See [`apps/ui/README.md`](https://github.com/roziscoding/jack/blob/main/apps/ui/README.md)
for the full UI configuration reference.

## Live updates

The UI doesn't poll. Overview, Downloads, and Settings each hold a
[Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream open through the BFF, and jack pushes a fresh snapshot the moment
something changes: a transfer's progress, a connector's state, or a peer or
server you just edited. There is no refresh interval to tune and no manual
refresh button.

The streams are plain `GET` endpoints on the management API:

| Stream | What it pushes |
| --- | --- |
| `/overview/stream` | Connector overview + download state |
| `/downloads/stream` | Every persisted download change |
| `/config/stream` | Peer and server config changes |

Each sends its current snapshot immediately on connect, then a full snapshot per
change, with no deltas to reassemble. A `ping` event every 15 seconds keeps idle
proxies from dropping the connection. The Logs page tails `/logs/stream`, which
works the same way except each event is a single log line rather than a
snapshot.

The browser reconnects on its own if a stream drops; Overview and Downloads show
a ***Live*** badge that flips to ***Reconnecting...*** while it's down.

**Behind a reverse proxy:** SSE needs response buffering **off** and an idle
timeout **longer than 15 seconds** on whatever sits in front of the UI. jack
sends `X-Accel-Buffering: no` (nginx and compatible proxies honour it) and the
BFF forwards that header, but proxies that buffer regardless, or cut idle
connections early, will leave the UI stuck on ***Reconnecting...***. See
[Troubleshooting](/guide/troubleshooting#management-ui-stuck-on-reconnecting).

## Management API

The UI's backing API, the **management API**, is a separate listener on its
own port (`MANAGEMENT_PORT`, default `5226`), started only when
`JACK_MANAGEMENT_KEY` is set. It can read and rewrite your whole config,
including connector credentials, so treat it as an admin socket:

Anyone who can reach it with the key controls your jack, and can read the
config, redirect downloads, or point your *arr connectors elsewhere. A single
bug in its auth check would hand that to anyone who can reach it at all.

That's why the default compose setup is the way it is, and why you shouldn't
change it: it publishes no host port for `5226`, so the management API is
reachable only from inside the Docker network, which holds exactly the one thing
that needs it, the UI's BFF. If you want remote management, expose the **UI**
behind an authenticating proxy and let it do the talking.

If you truly need to expose the management API itself, don't let its key be
the only lock. Put an independent auth layer in front, such as Cloudflare
Access, Authelia, or Traefik forward-auth, so a bug in jack's auth isn't a bug
in *your* perimeter. No code is immune to bugs; defense in depth is the
point.
