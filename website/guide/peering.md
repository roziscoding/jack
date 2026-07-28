---
description: Connect jack instances securely, exchange scoped peer API keys, and share Radarr or Sonarr media libraries with trusted friends.
---

# API keys & peering

jack authenticates each external surface by **key type**, so a credential only
works where it's meant to (`/ping` is the only unauthenticated route):

- **Peer API keys.** Issued per peer from the management UI's *API keys* section
  (or the management API) — named, revocable, and optionally expiring. Scoped to
  the **peer API** (`/handshake`, `/peer/*`): a peer key **cannot** query your
  Torznab indexer or act as your download client.
- **Managed keys.** jack mints these automatically and registers them in your
  Radarr/Sonarr when it auto-registers as their indexer + download client.
  Scoped to the ***arr surface** (`/torznab`, the qBittorrent API); you never
  see or handle them.

So keys flow in two directions:

- Your **Radarr/Sonarr** authenticate with the managed key jack registered for
  them (as the Torznab `apikey` and the download-client password).
- Your **peers** send the peer API key you issued them as the `X-Api-Key` header
  when they search or download from you.

## Sharing with friends (peering)

Peering is symmetric — you each run jack and exchange two things: a URL where
the other instance can reach your peer API and a **peer API key**. This public
or LAN-reachable peer URL is independent of `jack.internalUrl`, which is the
address your own Radarr/Sonarr use to reach jack.

- **You give a friend** your reachable peer URL plus a peer API key you issue
  them (management UI → *API keys*). They add you under `peers` in *their*
  config:

  ```jsonc
  {
    "peers": [
      { "name": "you", "url": "https://your-jack.example.com", "apiKey": "<the key you issued them>" }
    ]
  }
  ```

- **They give you** theirs, and you add them the same way in your config.

After that, each side's Radarr/Sonarr can find and pull media the other has.

::: tip One key per peer
Issue a **separate key per peer**. Each is scoped to the peer API — it can't
reach your indexer or download client — and can be revoked individually without
disrupting your other peers.
:::

::: warning Use HTTPS for peer URLs
The key travels in the `X-Api-Key` request header, so a plain `http://` peer
exposes it in transit to anything on the path. jack logs a warning at startup
for any peer configured over `http://`.
:::
