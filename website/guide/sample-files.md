---
description: Copy ready-to-use Docker Compose, environment, JSONC configuration, and OpenTelemetry example files for a self-hosted jack installation.
---

# Sample files

The example files jack ships with, rendered straight from the repo's
[`examples/`](https://github.com/roziscoding/jack/tree/main/examples) folder.
[Getting started](/guide/getting-started) walks through adapting them.

Fetch them all:

```bash
mkdir jack && cd jack
curl -LO https://raw.githubusercontent.com/roziscoding/jack/main/examples/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/roziscoding/jack/main/examples/.env.example
mkdir config
curl -L -o config/config.jsonc https://raw.githubusercontent.com/roziscoding/jack/main/examples/config.jsonc
```

## `docker-compose.yml`

The standard deployment: the jack backend plus the management UI.

<<< ../../examples/docker-compose.yml

## `config.jsonc`

The configuration template — see the
[configuration reference](/reference/configuration) for every key.

<<< ../../examples/config.jsonc{jsonc}

## `.env`

Secrets and optional overrides read by the compose file. Ships as
`.env.example`; save it as `.env` next to the compose file.

<<< ../../examples/.env.example{ini}

## `compose-with-otel.yml`

An alternative compose that adds an [OpenObserve](https://openobserve.ai)
service and wires jack's [OpenTelemetry](/reference/environment-variables#opentelemetry)
tracing to it.

<<< ../../examples/compose-with-otel.yml
