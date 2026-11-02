#!/usr/bin/env bash
#MISE description="Remove the dev:preview containers, delete the dev database and apps/backend/logs, and delete apps/backend/config.jsonc if dev:preview created it (what dev:preview does on exit without --keep)"
#MISE alias="preview:clean"
set -euo pipefail

config_file="apps/backend/config.jsonc"
marker="// <<< preview config file >>>"
# The backend writes logs to logs/ next to its config, the folder the
# container mounts as /config.
logs_dir="apps/backend/logs"

docker compose -f "$(dirname "$0")/compose.yaml" down
mise run db:cleanup

if [ -d "$logs_dir" ]; then
  rm -rf "$logs_dir"
  echo "Deleted $logs_dir"
fi

# Only a config copied from the preview template starts with the marker.
if [ -f "$config_file" ] && [ "$(head -n 1 "$config_file")" = "$marker" ]; then
  rm "$config_file"
  echo "Deleted $config_file (created by dev:preview)"
fi
