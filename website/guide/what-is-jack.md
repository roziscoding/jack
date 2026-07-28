---
description: Understand how jack privately shares Radarr and Sonarr media libraries between friends without public trackers or a BitTorrent swarm.
---

# What is jack?

**jack** lets you and your friends share media libraries with each other through
the *arr stack you already run. You point Radarr/Sonarr at jack, search like you
would on any indexer, and when a friend has the movie or episode you want, jack
pulls it straight from their server into your library — no public trackers, no
BitTorrent swarm, just a private peer-to-peer bridge between your media servers.

Built with [Bun](https://bun.com) and [Hono](https://hono.dev).

## Concepts

jack sits between three kinds of servers. You only need to configure the ones
relevant to what you want to do (share, consume, or both).

jack talks to **Radarr/Sonarr** for everything — there's no separate media
server. Each server you configure is one entry in `servers`, with two role
flags (it can be either, or both):

| Role | What it does | You need it to… |
| --- | --- | --- |
| **`source`** | jack reads your Radarr/Sonarr library and serves it to peers: it searches your movies/episodes that have files and streams those files. | **Share** your library with friends. |
| **`destination`** | jack registers itself in that Radarr/Sonarr as a Torznab indexer + qBittorrent download client and triggers imports of finished downloads. | **Consume** — drive everything from your existing *arr UI. |
| **Peer** | Another **jack** instance — a friend. You list their URL + API key under `peers`; jack queries them when your *arr searches. | **Consume** media your friends have. |

So a typical "both" setup has your Radarr/Sonarr as `source: true` **and**
`destination: true` (share your library *and* search your friends'), plus some
**peers** (friends, to consume from).

::: tip What's Torznab?
**Torznab** is the search API that indexers speak to Radarr/Sonarr (the same
protocol Prowlarr/Jackett expose). jack pretends to be a Torznab indexer so
your *arr apps can search your friends' libraries with zero special setup —
to them, jack looks like any other indexer.
:::

## Next steps

- [Getting started](/guide/getting-started) — run jack with Docker Compose.
- [How it works](/guide/how-it-works) — the search and download flows in detail.
- [API keys & peering](/guide/peering) — exchange keys with friends and start sharing.
