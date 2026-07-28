---
description: Reference every jack JSONC configuration option for internal URLs, downloads, Radarr and Sonarr servers, peer connections, retries, and imports.
---

# Configuration

jack reads a [JSONC](https://github.com/microsoft/node-jsonc-parser) file
(comments allowed) from `APP_CONFIG_PATH` (default `/config/config.jsonc`). If
the file doesn't exist, jack writes a default one on first boot. Copy
[`examples/config.jsonc`](https://github.com/roziscoding/jack/blob/main/examples/config.jsonc)
as a starting point.

The `jack` block is required. `downloads`, `servers`, and `peers` are optional —
configure only what you need for what you're doing. (A top-level `version`
number also appears in the file; jack manages it for config migrations, so leave
it alone.)

## Quick reference

| Key | What it does |
| --- | --- |
| [`jack.internalUrl`](#jack-internalurl) | URL your *arr apps use to reach jack |
| [`jack.tmdbApiKey`](#jack-tmdbapikey) | TMDB metadata for the catalog |
| [`downloads.completedPath`](#downloads-completedpath) | Where finished downloads go |
| [`downloads.maxConcurrentDownloads`](#downloads-maxconcurrentdownloads) | Simultaneous transfer cap |
| [`downloads.maxDownloadAttempts`](#downloads-maxdownloadattempts) | Retries before a download fails |
| [`downloads.retryBaseDelayMs`](#downloads-retrybasedelayms) | Download retry backoff base |
| [`downloads.retryMaxDelayMs`](#downloads-retrymaxdelayms) | Download retry backoff cap |
| [`downloads.idleTimeoutMs`](#downloads-idletimeoutms) | Stalled-transfer timeout |
| [`downloads.importPollIntervalMs`](#downloads-importpollintervalms) | Import watcher poll cadence |
| [`downloads.maxManualImportAttempts`](#downloads-maxmanualimportattempts) | Retries before an import fails |
| [`downloads.manualImportBackoffBaseMs`](#downloads-manualimportbackoffbasems) | Import retry backoff base |
| [`downloads.manualImportBackoffMaxMs`](#downloads-manualimportbackoffmaxms) | Import retry backoff cap |
| [`servers[].name`](#servers-name) | Display name |
| [`servers[].type`](#servers-type) | Radarr or Sonarr |
| [`servers[].url`](#servers-url) | *arr base URL |
| [`servers[].apiKey`](#servers-apikey) | *arr API key |
| [`servers[].headers`](#servers-headers) | Extra outbound headers |
| [`servers[].source`](#servers-source) | Share this library with peers |
| [`servers[].destination`](#servers-destination) | Search + import through this *arr |
| [`servers[].autoregister`](#servers-autoregister) | Indexer/client registration control |
| [`peers[].name`](#peers-name) | Display name |
| [`peers[].url`](#peers-url) | Friend's peer URL |
| [`peers[].apiKey`](#peers-apikey) | Key the friend issued you |
| [`peers[].headers`](#peers-headers) | Extra outbound headers |

## `jack`

This instance's identity. Required.

### `jack.internalUrl`

**Type:** `string` · **Required**\
**Format:** URL

URL your own *arr apps use to reach jack — the address jack registers for its
Torznab indexer and qBittorrent download client. Must be resolvable **from the
Radarr/Sonarr side**: on a shared Docker network use the container name
(`http://jack:5225`); otherwise the host IP/domain. Peers never use this URL —
they use whatever you hand them (see [API keys & peering](/guide/peering)).

### `jack.tmdbApiKey`

**Type:** [`ConfigSecret`](#configsecret)

TMDB v3 API key, used by the management UI's catalog to enrich peer libraries
with artwork and metadata.

## `downloads`

Needed to **consume** (download) from peers — jack only registers itself as a
qBittorrent download client when this block is present. Everything except
`completedPath` is an optional tuning knob with a sensible default.

### `downloads.completedPath`

**Type:** `string` · **Required**\
**Format:** non-empty filesystem path (inside jack's container)

Where jack writes finished downloads. The path is inside jack's container; jack
creates it if missing. It must also be mounted into your **Radarr and Sonarr**
containers at the **same path** — *arr resolves it in its own filesystem to
import finished files (see the callout in
[Getting started](/guide/getting-started)).

### `downloads.maxConcurrentDownloads`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `3`

Maximum simultaneous transfers from peers.

### `downloads.maxDownloadAttempts`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `13`

How many times a failing download is attempted before it's marked failed.

### `downloads.retryBaseDelayMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `1000`

Base delay for the exponential backoff between download retries.

### `downloads.retryMaxDelayMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `1800000`

Upper bound for the download retry backoff. The default is 30 minutes.

### `downloads.idleTimeoutMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 1000\
**Default:** `60000`

How long a transfer may go without receiving data before it's considered
stalled and retried.

### `downloads.importPollIntervalMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 1000\
**Default:** `30000`

How often the import watcher polls each destination *arr's history to detect
which finished downloads were imported.

### `downloads.maxManualImportAttempts`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `6`

When a manual import trigger keeps failing (e.g. *arr returns 500 because the
title's library folder is missing), jack backs off between attempts and gives
up — marking the download failed — after this many attempts.

### `downloads.manualImportBackoffBaseMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `60000`

Base delay for the manual-import retry backoff.

### `downloads.manualImportBackoffMaxMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `1800000`

Upper bound for the manual-import retry backoff. The default is 30 minutes.

## `servers`

Your Radarr/Sonarr servers. Each entry can be a source, a destination, or both
(see [Concepts](/guide/what-is-jack#concepts)).

### `servers[].name`

**Type:** `string` · **Required**

Display name, used in logs, health output, and search results.

### `servers[].type`

**Type:** `"radarr" | "sonarr"` · **Required**

Which *arr this server is.

### `servers[].url`

**Type:** `string` · **Required**\
**Format:** URL

Base URL of the *arr server, reachable from jack.

### `servers[].apiKey`

**Type:** [`ConfigSecret`](#configsecret) · **Required**\
**Format:** resolves to exactly 32 hexadecimal characters

The Radarr/Sonarr API key (Settings → General).

### `servers[].headers`

**Type:** `object`\
**Content:** header name → [`ConfigSecret`](#configsecret) value\
**Default:** `{}`

Extra HTTP headers sent to this server, for reverse proxies or access layers
such as Cloudflare Access or Authelia. These are outbound connector headers
only; jack still adds the required *arr `X-Api-Key` auth header separately.

### `servers[].source`

**Type:** `boolean`\
**Default:** `true`

Share this library with peers.

### `servers[].destination`

**Type:** `boolean`\
**Default:** `true`

Register jack in this server as an indexer + download client and import grabs
into it.

### `servers[].autoregister`

**Type:** `object`\
**Content:** `enable`: `boolean`, default `true` · `priority`: `integer` ≥ 1, default `1`

Controls the indexer/download-client registration jack performs in destination
servers on startup.

- **`enable`** — set `false` to register jack in that *arr yourself.
- **`priority`** — indexer priority in *arr (lower = preferred). The
  qBittorrent download client is always registered at *arr's lowest priority
  (50): *arr's general client pool only round-robins among the best-priority
  group, so torrents grabbed from your other indexers never get routed to
  jack's client. Grabs from the Jack indexer still reach it because the indexer
  is bound to the client explicitly (`downloadClientId`), which *arr resolves
  before applying priority.

## `peers`

Other jack instances (friends) you consume from. Sources only — sharing back is
configured on *their* side.

### `peers[].name`

**Type:** `string` · **Required**

Display name, used in logs, health output, and search results.

### `peers[].url`

**Type:** `string` · **Required**\
**Format:** URL

The reachable peer URL your friend gave you. Use `https://` — the API key
travels in a request header, and jack logs a startup warning for `http://`
peers.

### `peers[].apiKey`

**Type:** [`ConfigSecret`](#configsecret) · **Required**

The peer API key that friend issued *you* (see
[API keys & peering](/guide/peering)), not your own.

### `peers[].headers`

**Type:** `object`\
**Content:** header name → [`ConfigSecret`](#configsecret) value\
**Default:** `{}`

Extra HTTP headers sent to this peer — same semantics as
[`servers[].headers`](#servers-headers), e.g. Cloudflare Access service tokens.

## `ConfigSecret`

Every secret-valued key shares the `ConfigSecret` type: a value that can be
given as a plain string, as a reference to an environment variable, or as a
reference to a secret file, so secrets can stay out of the config file:

```jsonc
{
  // plain string
  "apiKey": "plain-string"
}
```

```jsonc
{
  // environment variable reference
  "apiKey": { "env": "RADARR_API_KEY" }
}
```

```jsonc
{
  // secret file reference
  "apiKey": { "file": "/run/secrets/radarr_api_key" }
}
```

All three forms are interchangeable everywhere a secret appears (`jack`,
`servers`, `peers`, and `headers` values). File paths must be absolute;
trailing line endings are ignored. If a referenced variable is unset/empty, or
a secret file cannot be read or resolves to an empty value at startup, jack
reports the problem and refuses to load that config.

## Full example

```jsonc
{
  "jack": {
    "internalUrl": "http://jack:5225",
    "tmdbApiKey": { "env": "TMDB_API_KEY" }
  },
  "downloads": {
    "completedPath": "/data/torrents/completed",
    "maxConcurrentDownloads": 3
  },
  "servers": [
    {
      "name": "Main Radarr",
      "type": "radarr",
      "url": "http://radarr:7878",
      "apiKey": { "env": "RADARR_API_KEY" },
      "source": true,
      "destination": true,
      "autoregister": {
        "enable": true,
        "priority": 1
      }
    },
    {
      "name": "Main Sonarr",
      "type": "sonarr",
      "url": "http://sonarr:8989",
      "apiKey": { "env": "SONARR_API_KEY" }
    }
  ],
  "peers": [
    {
      "name": "friend",
      "url": "https://their-jack.example.com",
      "apiKey": { "env": "FRIEND_JACK_API_KEY" },
      "headers": {
        "CF-Access-Client-Id": { "env": "FRIEND_CF_CLIENT_ID" },
        "CF-Access-Client-Secret": { "env": "FRIEND_CF_CLIENT_SECRET" }
      }
    }
  ]
}
```
