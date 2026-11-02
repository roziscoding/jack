#!/usr/bin/env bash
#MISE description="Migrate and seed the dev database, then run the backend and UI from the working tree in Docker (attached). Removes the containers and the database on exit unless --keep is set."
#MISE alias="preview"
#USAGE flag "--keep" help="Keep the containers and the seeded database after compose exits"
set -euo pipefail

# The backend container runs as the host user (see compose.yaml).
JACK_UID="$(id -u)"
JACK_GID="$(id -g)"
export JACK_UID JACK_GID

preview_dir="$(dirname "$0")"
compose_file="$preview_dir/compose.yaml"
# Same config the container mounts as /config/config.jsonc.
config_file="apps/backend/config.jsonc"

marker="// <<< preview config file >>>"

# A config that starts with the marker came from this template, so it's
# refreshed to pick up template changes. A config you wrote yourself is never
# touched.
if [ ! -f "$config_file" ]; then
  cp "$preview_dir/config.jsonc" "$config_file"
  echo "Created $config_file from the preview template"
elif [ "$(head -n 1 "$config_file")" = "$marker" ]; then
  cp "$preview_dir/config.jsonc" "$config_file"
  echo "Refreshed $config_file from the preview template"
fi

# After the config exists: the seed fills the catalog cache for the configured
# peers, so it has to see the template's sample peers.
mise run db:seed

teardown() {
  if [ "${usage_keep:-false}" = "true" ]; then
    echo "--keep set: leaving the containers and the database in place"
    return
  fi
  mise run dev:preview:clean
}
trap teardown EXIT

docker compose -f "$compose_file" up --build
