# Getting started

This guide takes you from nothing to a running jack instance: configured
against your Radarr/Sonarr, registered there as an indexer and download
client, with the management UI up and ready to connect to friends. Docker
Compose is the recommended way to self-host jack — two images are published to
GitHub Container Registry on every push to `main`, so there's nothing to build.

## Before you start

You'll need:

- **Docker with Compose.**
- **Radarr and/or Sonarr already running**, and their API keys (Settings →
  General → API Key).
- **To know your media paths** — the paths *inside* your Radarr/Sonarr
  containers where media lives (e.g. `/movies`, `/tv`, or `/data/media`).
  jack streams files using those exact paths, so you'll mirror them.

If you haven't yet, skim [What is jack?](/guide/what-is-jack) — the rest of
this guide assumes you know what a *source*, *destination*, and *peer* are.

## 1. Create the project files

jack runs from three files: a compose file, an env file for secrets, and a
config file. Create a folder with this layout:

```
jack/
├── docker-compose.yml
├── .env
└── config/
    └── config.jsonc
```

Start from the examples below — they're working templates, and the
rest of this guide assumes them as the starting point: the next steps walk you
through adapting each part to your setup.

::: code-group

<<< ../../examples/docker-compose.yml [docker-compose.yml]

<<< ../../examples/config.jsonc{jsonc} [config/config.jsonc]

<<< ../../examples/.env.example{ini} [.env]

:::

Or, if you'd rather not copy-paste, fetch them:

```bash
mkdir jack && cd jack
curl -LO https://raw.githubusercontent.com/roziscoding/jack/main/examples/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/roziscoding/jack/main/examples/.env.example
mkdir config
curl -L -o config/config.jsonc https://raw.githubusercontent.com/roziscoding/jack/main/examples/config.jsonc
```

## 2. Fill in `config.jsonc`

Open `config/config.jsonc` in your editor. The template is heavily commented;
these are the parts that matter:

### `jack.internalUrl`

The address **your own Radarr/Sonarr** will use to reach jack — it's what jack
registers as the indexer and download-client URL. If your *arr apps run on the
same Docker network as jack, the default `http://jack:5225` (the container
name) is correct. If they run elsewhere, use the host's IP or domain:

```jsonc
{
  "jack": {
    "internalUrl": "http://jack:5225"
  }
}
```

### `downloads`

Where jack writes finished downloads (path inside the container). Keep the
default unless you have a reason not to — you'll mount a host folder here in
step 4:

```jsonc
{
  "downloads": {
    "completedPath": "/data/torrents/completed"
  }
}
```

### `servers`

One entry per Radarr/Sonarr. Set each server's URL, and reference the API keys
from the environment — you'll put the actual values in `.env` in the next step,
and the compose file forwards them into the container:

```jsonc
{
  "servers": [
    {
      "name": "Main Radarr",
      "type": "radarr",
      "url": "http://radarr:7878",
      "apiKey": { "env": "RADARR_API_KEY" }
    },
    {
      "name": "Main Sonarr",
      "type": "sonarr",
      "url": "http://sonarr:8989",
      "apiKey": { "env": "SONARR_API_KEY" }
    }
  ]
}
```

By default each server is both a **source** (share its library with friends)
and a **destination** (search your friends' libraries from its UI). Set
`"source": false` or `"destination": false` to opt out of either — see the
[configuration reference](/reference/configuration#servers) for these and the
other per-server options.

::: info
You can also inline a key as a plain string (`"apiKey": "abc123..."`), but
it's not recommended — the config file then holds live secrets. See
[`ConfigSecret`](/reference/configuration#configsecret) for all the forms,
including reading from a secret file.
:::

### `peers`

Leave it empty (or delete it) for now — you'll add friends through the
management UI in step 6.

## 3. Fill in `.env`

Open `.env` and fill in the values:

- **`JACK_MANAGEMENT_KEY`** — the secret gating the management API (and the
  UI's access to it). Both containers read this same variable: the backend
  requires it on every management request, and the UI injects it, so they
  always match. Generate one:

  ```bash
  openssl rand -base64 32
  ```

- **`RADARR_API_KEY` / `SONARR_API_KEY`** — the *arr API keys your
  `config.jsonc` references (Settings → General → API Key).

## 4. Line up the mounts

The compose file mounts three host paths into jack. Two of them **must mirror
your *arr containers** — this is the part people get wrong, so take a minute
here:

| Mount | Purpose |
| --- | --- |
| `./config` → `/config` | Config, database, and logs |
| `${MEDIA_PATH:-./data/media}` → `/data/media` | Your media, so jack can stream it to peers |
| `${TORRENTS_PATH:-./data/torrents}` → `/data/torrents` | Download path |

### Media

jack streams files to peers using the absolute path each *arr
stores for the file — the path *inside the Radarr/Sonarr container*. Mount
your media into jack at that **same path**. The `/data/media` target in the
compose file is a placeholder: if your Radarr sees movies at `/movies` and
Sonarr sees shows at `/tv`, replace it with one mount per path:

```yaml
volumes:
  - /srv/media/movies:/movies
  - /srv/media/tv:/tv
```

### Download path

jack's downloads live under this mount — in particular, finished files are
written to the literal `downloads.completedPath`, and your *arr imports them
by resolving that same path in *its own* filesystem. So mount the same host
folder into jack **and** into Radarr/Sonarr at the same container path:

```yaml
# jack (already in the compose file)
volumes:
  - ./data/torrents:/data/torrents
```

```yaml
# radarr AND sonarr
volumes:
  - ./data/torrents:/data/torrents
```

Use a dedicated folder — don't point it at a folder another download client
already writes to. jack runs as uid/gid 1000 (matching the linuxserver.io
defaults), so make sure the folder is writable by that user.

### Networking

If Radarr/Sonarr run in their own compose network, uncomment
the `networks:` block at the bottom of the compose file so jack joins it —
otherwise container names like `http://radarr:7878` and `http://jack:5225`
won't resolve. Optionally also uncomment `depends_on` so jack starts after
your *arr apps are healthy and registration succeeds on first boot.

## 5. Start it

```bash
docker compose up -d
docker compose logs -f jack
```

In the logs you should see:

- `Server listening` — jack is up.
- `Registered Jack as Torznab indexer` and `Registered Jack as qBittorrent
  download client` — once per destination server.

Verify from the outside:

```bash
curl http://localhost:5225/ping
# {"status":"OK"}
```

(The Docker image also wires `/ping` up as its `HEALTHCHECK`, so `docker ps`
reports container health automatically.)

Then open the management UI at **http://localhost:3000**. The Overview page
shows your servers and whether each connector initialized cleanly. In
Radarr/Sonarr, you'll find a new **Jack** indexer under Settings → Indexers
and a **Jack** download client under Settings → Download Clients — both tests
should pass.

If something's off, the [troubleshooting guide](/guide/troubleshooting) covers
the common failures.

## 6. Connect with a friend

jack is useful once you're peered with someone (they run jack too — send them
this page). Peering is symmetric and takes one exchange in each direction:

1. In the management UI, go to **API keys** and issue a key named after your
   friend. Send them that key plus the URL where your peer API is reachable
   from the internet (a reverse-proxied `https://` address — not
   `jack.internalUrl`).
2. They do the same for you, and you add them under **Peers** in your UI with
   the URL and key they sent.

See [API keys & peering](/guide/peering) for how the keys are scoped and why
each peer gets their own.

## 7. Use it

That's it — from here everything happens in your normal *arr workflow. Search
for a movie or episode as you always would: releases your friends have show up
as **Jack** indexer results, and grabbing one pulls the file straight from
their server into your library.

## Next steps

- [How it works](/guide/how-it-works) — what actually happens on search and
  grab.
- [Management UI](/guide/management-ui) — day-to-day operation and access
  control.
- [Configuration reference](/reference/configuration) — every key, including
  the download tuning knobs.
- [Running without Docker](/guide/running-without-docker) — for bare-metal
  setups.
