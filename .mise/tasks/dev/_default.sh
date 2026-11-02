#!/usr/bin/env sh
#MISE description="Run the backend and UI in Docker (attached) from the development image stages; Compose Watch syncs local edits in for hot reload"
#MISE depends=["db:migrate"]
#USAGE flag "--seed" help="Reset the downloads table and fill it with sample data (db:seed) before starting"
set -e

# The backend container runs as the host user (see compose.yaml).
JACK_UID="$(id -u)"
JACK_GID="$(id -g)"
export JACK_UID JACK_GID

if [ "${usage_seed:-false}" = "true" ]; then
  mise run db:seed
fi

docker compose -f "$(dirname "$0")/compose.yaml" up --build --watch
