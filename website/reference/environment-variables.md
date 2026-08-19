---
description: Reference jack environment variables for ports, configuration paths, management authentication, logging, timeouts, and OpenTelemetry tracing.
---

# Environment variables

All variables are optional; jack boots with sensible defaults for a Docker
setup. They configure the backend process; for the management UI's own
variables, see [`apps/ui/README.md`](https://github.com/roziscoding/jack/blob/main/apps/ui/README.md).

## Quick reference

| Variable | What it does |
| --- | --- |
| [`PORT`](#port) | Public listener port |
| [`ENVIRONMENT`](#environment) | Pretty vs JSON logs |
| [`APP_CONFIG_PATH`](#app-config-path) | Config file location |
| [`HTTP_TIMEOUT_MS`](#http-timeout-ms) | Outbound request timeout |
| [`JACK_MANAGEMENT_KEY`](#jack-management-key) | Enables + guards the management API |
| [`MANAGEMENT_PORT`](#management-port) | Management listener port |
| [`LOG_LEVEL`](#log-level) | Minimum level to log |
| [`ENABLE_LOGS`](#enable-logs) | Turn logging off entirely |
| [`LOG_TO_FILE`](#log-to-file) | Persist logs for the UI's Logs view |
| [`LOG_DIR`](#log-dir) | Where log files go |
| [`LOG_MAX_FILE_BYTES`](#log-max-file-bytes) | Log rotation size |
| [`LOG_MAX_FILES`](#log-max-files) | Rotated files to keep |
| [`OTEL_EXPORTER_OTLP_ENDPOINT`](#otel-exporter-otlp-endpoint) | Enables tracing, receives OTLP data |
| [`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`](#otel-exporter-otlp-traces-endpoint) | Traces-specific OTLP endpoint |
| [`OTEL_SERVICE_NAME`](#otel-service-name) | Telemetry service name |

## Server

### `PORT`

**Type:** `integer`\
**Default:** `5225`

Port for the public HTTP listener (peer API, Torznab, qBittorrent).

### `ENVIRONMENT`

**Type:** `"development" | "production"`\
**Default:** `"development"`

`production` switches logs to JSON (no pretty-print).

### `APP_CONFIG_PATH`

**Type:** `string`\
**Format:** filesystem path\
**Default:** `/config/config.jsonc`

Path to the [configuration file](/reference/configuration). Written with a
default config on first boot if it doesn't exist.

### `HTTP_TIMEOUT_MS`

**Type:** `integer`\
**Format:** milliseconds, > 0\
**Default:** `30000`

Timeout for every outbound HTTP request to a connector (*arr or peer). Bounds a
hung host so it can't stall a search indefinitely.

## Management API

### `JACK_MANAGEMENT_KEY`

**Type:** `string`\
**Format:** non-empty; unset disables the management API

Management API credential. When set, the management API starts on
`MANAGEMENT_PORT` and every request must carry it as the `X-Management-Key`
header. When unset, the management listener never starts and jack runs
headless.

### `MANAGEMENT_PORT`

**Type:** `integer`\
**Default:** `5226`

Port for the management API listener, separate from `PORT` so the peer-facing
port never exposes management. Only used when a management key is set.

## Logging

### `LOG_LEVEL`

**Type:** `"trace" | "debug" | "info" | "warn" | "error" | "fatal"`\
**Default:** `"info"`

Minimum level to log. `trace` also logs every HTTP request as it completes,
with method, path, response status, and duration.

### `ENABLE_LOGS`

**Type:** `boolean`\
**Default:** `true`

Set `false` to disable logging entirely. Logging is also disabled automatically
when `NODE_ENV=test`.

### `LOG_TO_FILE`

**Type:** `boolean`\
**Default:** `true`

Persist logs to rotating NDJSON files, which the management API serves to the
UI's Logs view. Disabled automatically when `NODE_ENV=test`.

### `LOG_DIR`

**Type:** `string`\
**Format:** filesystem path\
**Default:** `logs/` next to `APP_CONFIG_PATH`

Directory for the rotating log files. The default keeps them on the same
persistent volume as the config and database.

### `LOG_MAX_FILE_BYTES`

**Type:** `integer`\
**Format:** bytes, > 0\
**Default:** `10485760`

Rotate the active log file once it reaches this size (10 MiB by default).

### `LOG_MAX_FILES`

**Type:** `integer`\
**Format:** ≥ 0\
**Default:** `5`

How many rotated files to keep in addition to the active one; older files are
pruned.

## OpenTelemetry

Tracing has no on/off flag: it's enabled as soon as an OTLP/HTTP endpoint is
configured, via either endpoint variable. When enabled, jack emits request
traces and bridges its logs into OpenTelemetry logs. Request spans include
redacted headers/query attributes and bounded textual request/response bodies;
binary bodies are omitted. See
[`examples/compose-with-otel.yml`](https://github.com/roziscoding/jack/blob/main/examples/compose-with-otel.yml)
for a compose setup with OpenObserve.

### `OTEL_EXPORTER_OTLP_ENDPOINT`

**Type:** `string`\
**Format:** URL

Base OTLP/HTTP endpoint to send traces and logs to. Setting it enables
OpenTelemetry.

### `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`

**Type:** `string`\
**Format:** URL

Signal-specific endpoint for traces. Also enables OpenTelemetry when set;
useful when traces go to a different endpoint than other signals.

### `OTEL_SERVICE_NAME`

**Type:** `string`\
**Default:** `jack-backend`

Service name attached to emitted telemetry.

## Sample `.env`

```ini
PORT=5225
ENVIRONMENT=production
APP_CONFIG_PATH=/config/config.jsonc
HTTP_TIMEOUT_MS=30000

JACK_MANAGEMENT_KEY=change-me-to-something-long-and-random
MANAGEMENT_PORT=5226

LOG_LEVEL=info
ENABLE_LOGS=true
LOG_TO_FILE=true
LOG_DIR=/config/logs
LOG_MAX_FILE_BYTES=10485760
LOG_MAX_FILES=5

OTEL_EXPORTER_OTLP_ENDPOINT=http://openobserve:5080/api/default
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://openobserve:5080/api/default/v1/traces
OTEL_SERVICE_NAME=jack-backend
```
