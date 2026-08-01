---
description: Diagnose jack connectivity, Radarr or Sonarr registration, qBittorrent client checks, downloads, imports, permissions, management UI live updates, and peer errors.
---

# Troubleshooting

Registration runs on every startup and logs the *arr response body, so check
`docker compose logs jack` first. The common failures:

## Radarr/Sonarr report failures talking to Jack

Once registered, *arr health checks and grabs can start failing with messages
like:

```
Unable to communicate with Jack.
Failed to connect to qBittorrent, please check your settings.
```

First, a decoding tip: when *arr mentions **Jack** and **qBittorrent** in the
same breath, it's talking about **jack's qBittorrent API**. *arr doesn't know
jack isn't a real qBittorrent instance — jack registered itself as one — so
this **does not** mean your own qBittorrent has a problem (if you even run
one). Both the indexer and the download client point at jack, so either way
the failure is *arr ↔ jack.

That leaves three usual causes:

- **jack isn't running.** Check `docker compose ps` / the container logs.
- **jack is unreachable from *arr.** Same networking story as
  [below](#qbittorrent-download-client-test-fails-failed-to-register-download-client):
  `jack.internalUrl` must resolve from the Radarr/Sonarr side.
- **The managed key is no longer valid** — for example after wiping jack's
  database. **Restart jack**: auto-registration runs again on startup and
  updates the registration with a fresh, valid key.

## qBittorrent download client test fails / `Failed to register download client`

The qBittorrent client *arr registers (or the "Test" button in
Settings → Download Clients) connects to jack's qBittorrent API at the host/port
jack derives from `jack.internalUrl`. A failing test almost always means *arr
can't reach that address.

**Fix:** make sure `jack.internalUrl` is resolvable **from the Radarr/Sonarr
side**. On a shared Docker network use the container name (`http://jack:5225`);
otherwise the host IP/domain. If *arr and jack are on different networks, attach
jack to *arr's network (the `networks:` block in the example compose).

## Grabs download but never import

The download completes in jack (you see it finish in the logs) but Radarr/Sonarr
never pick the file up. jack writes finished files to the **literal**
`downloads.completedPath`, and *arr imports them by resolving that path in **its
own** filesystem — so the completed folder must exist at the **same path**
inside the Radarr/Sonarr containers.

**Fix:** mount the **same host folder** into Radarr **and** Sonarr at the **same
container path** jack uses. If jack has:

```yaml
# jack
volumes:
  - /srv/media/jack-completed:/data/torrents/completed
```

then Radarr and Sonarr each need:

```yaml
# radarr AND sonarr
volumes:
  - /srv/media/jack-completed:/data/torrents/completed
```

Two gotchas:

- **Use a dedicated completed folder.** Don't point `completedPath` at a folder
  another download client (e.g. a real qBittorrent's `/downloads`) already
  writes to, or *arr will try to import unrelated files.
- **Permissions.** jack runs as **uid/gid 1000**, matching the `PUID/PGID` the
  linuxserver.io *arr images default to, so files jack writes are owned by the
  same user that imports them. Make sure the completed folder (and the `/config`
  mount) are readable/writable by uid 1000 — `chown -R 1000:1000` them; if your
  *arr uses a different `PUID`, set it to match.

## `No "downloads" config set` — no download client registered

```
No "downloads" config set; skipping download client auto-registration. Grabs will fail until a qBittorrent client is configured.
```

jack only registers the qBittorrent download client when a `downloads` block is
present in your config (it needs `completedPath` to know where to write files).
Without it, the Torznab indexer is still registered so searches work, but grabs
have nowhere to go.

**Fix:** add a `downloads` block with `completedPath` and restart jack.

If registration fails with `Failed to register indexer`, check that the
destination server is reachable and its API key is correct — registration logs
the raw *arr response body at `error` level.

## `ConnectionRefused` on startup

```
Failed to initialize connector radarr: Unable to connect. Is the computer able to access the url?
```

jack tries to connect to your servers at boot. If it starts before Radarr/Sonarr
are ready, those connectors fail initially and you'll see `sources:0` /
`destinations:0` in the `Server listening` line. Source and peer connectors are
retried lazily the next time a search/download needs them, so they can recover
without a restart once the remote service is up.

Auto-registration still runs only during startup, so a destination that was down
at boot may need a jack restart before the Torznab indexer or qBittorrent
download client is created in Radarr/Sonarr. To make startup deterministic, wait
for the dependencies to be healthy:

```yaml
# jack
depends_on:
  radarr: {condition: service_healthy}
  sonarr: {condition: service_healthy}
```

(This needs `healthcheck` blocks on those services — the linuxserver.io images
ship with them.)

## Management UI stuck on "Reconnecting…"

The Overview and Downloads pages show a **Live** badge while their
[event stream](/guide/management-ui#live-updates) is connected. If it sits on
**Reconnecting…** — or flips to it every few seconds — the stream is being
closed or buffered before it reaches the browser. The pages still load; they
just stop updating on their own.

Three usual causes:

- **A reverse proxy is buffering the response.** SSE only works if the proxy
  streams bytes through. jack sends `X-Accel-Buffering: no` and the UI's BFF
  forwards it, which nginx honours; for others turn buffering off explicitly
  (`proxy_buffering off;` on nginx, `flush_interval = -1` on Traefik, Caddy's
  `reverse_proxy` streams by default).
- **The proxy's idle timeout is too short.** Streams are idle between changes,
  with only a `ping` every 15 seconds. Give the UI route a read/idle timeout
  well above that — 60 seconds or more.
- **The management API is down or unreachable.** The BFF answers `503` when it
  can't reach jack. Check `docker compose ps` and the backend logs for
  `Management API listening`.

## Seeing what jack is doing

Set `LOG_LEVEL=trace` to log every HTTP request (method, path, status,
duration). Registration failures always log the raw *arr response body at
`error` level, which carries the real validation message — read that body, it
usually tells you exactly what *arr is unhappy about.
