---
description: Learn how jack connects Radarr and Sonarr through Torznab and qBittorrent-compatible APIs to search and transfer media between trusted peers.
---

# How it works

There are two flows: **searching** for media (Torznab) and **downloading** it
(the qBittorrent API). The `.torrent` files involved are *not real torrents* —
they're tiny stubs jack hands to *arr, which sends them back to jack through the
qBittorrent download-client API. Nothing ever touches BitTorrent.

## 1. Search flow (Torznab)

```mermaid
sequenceDiagram
    participant ARR as Radarr / Sonarr (you)
    participant JACK as jack (you)
    participant FJACK as jack (friend)
    participant FARR as Radarr/Sonarr (friend)

    ARR->>JACK: Torznab query /torznab/api?apikey=…
    JACK->>FJACK: /peer/search (X-Api-Key)
    FJACK->>FARR: search library (movies/episodes with files)
    FARR-->>FJACK: matching releases
    FJACK-->>JACK: results
    JACK-->>ARR: releases (stub .torrent)<br/>link → /torznab/download/{peerId}:{itemId}.torrent
```

The setup happens once, at startup: jack registers itself in each
`destination` Radarr/Sonarr as a **Torznab indexer** and — when `downloads` is
configured — as a **qBittorrent download client**. Both registrations point at
`jack.internalUrl` and authenticate with an auto-issued **managed key**. If
you'd rather register jack yourself, set that server's
[`autoregister.enable`](/reference/configuration#servers-autoregister) to
`false`.

From then on, every search works like this:

1. When you search or monitor something, Radarr/Sonarr query jack's `/torznab`
   endpoint with that managed key.
2. jack **fans the query out to every `peer`** you've configured, calling each
   one's `/peer/search` with the API key that peer issued you.
3. Each peer searches **its own Radarr/Sonarr** library — movies and episodes
   that have files — and returns matching releases, mirroring the *arr file
   metadata.
4. jack turns each match into a Torznab "release" whose download link points
   back at itself: `/torznab/download/<peerId>:<itemId>.torrent`.
5. Radarr/Sonarr show these as grabbable releases — indistinguishable from a
   normal indexer's results.

## 2. Download flow (qBittorrent API)

```mermaid
sequenceDiagram
    participant ARR as Radarr / Sonarr (you)
    participant JACK as jack (you)
    participant FJACK as jack (friend)

    ARR->>JACK: grab release → fetch stub .torrent
    ARR->>JACK: POST /api/v2/torrents/add (stub)
    Note over JACK: parse stub (peerId + itemId), queue download
    JACK->>FJACK: GET /peer/items/:id/file
    FJACK-->>JACK: streams real file from disk<br/>→ downloads.completedPath
    ARR->>JACK: GET /api/v2/torrents/info (poll progress)
    JACK-->>ARR: completed → content_path = finished file
    Note over ARR: scans completed folder, imports into library
```

1. You grab a release. Your *arr's download client is the **qBittorrent**
   client jack registered on startup, pointed at jack's own qBittorrent API —
   so *arr fetches the stub `.torrent` from jack and immediately POSTs it back
   to jack at `/api/v2/torrents/add`.
2. That `.torrent` is a **stub** — bencoded data that just encodes the
   `peerId` and `itemId`. No trackers, no pieces; it's never written to disk.
3. jack parses the stub, finds the matching peer, and queues the download.
4. jack **downloads the real file over HTTP** from that peer's
   `/peer/items/:id/file` endpoint into `downloads.completedPath`.
5. *arr polls jack's `/api/v2/torrents/info` for progress; once jack reports
   the torrent complete, *arr scans the completed folder and imports the file
   into your library, renamed and tracked.

## 3. Serving — being a peer to others

When a friend lists *you* as a peer, their jack calls your `/peer/*` endpoints,
authenticated with the peer API key you issued them:

- `/peer/search` — search your Radarr/Sonarr library.
- `/peer/items/:id` — release metadata.
- `/peer/items/:id/file` — stream the actual file.

jack streams files straight from disk using the paths your Radarr/Sonarr
report, so **the jack process must be able to read your media files at those
same paths** — mount your media into the container the same way your *arr apps
see it.
