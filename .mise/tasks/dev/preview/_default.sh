#!/usr/bin/env bash
#MISE description="Migrate and seed the dev database, then run the backend and UI from the working tree in Docker (attached). Removes the containers and the database on exit unless --keep is set."
#MISE alias="preview"
#MISE depends=["db:seed"]
#USAGE flag "--keep" help="Keep the containers and the seeded database after compose exits"
set -euo pipefail

preview_dir="$(dirname "$0")"
compose_file="$preview_dir/compose.yaml"
# Same config the container mounts as /config/config.jsonc.
config_file="apps/backend/config.jsonc"

if [ ! -f "$config_file" ]; then
  cp "$preview_dir/config.jsonc" "$config_file"
  echo "Created $config_file from the preview template"
fi

teardown() {
  if [ "${usage_keep:-false}" = "true" ]; then
    echo "--keep set: leaving the containers and the database in place"
    return
  fi
  mise run dev:preview:clean
}
trap teardown EXIT

docker compose -f "$compose_file" up --build
