#!/usr/bin/env sh
#MISE description="Generate a Drizzle migration from changes to apps/backend/src/database/schema.ts. Extra args go to drizzle-kit (e.g. --name add_error_code)."
set -e

cd apps/backend
bunx drizzle-kit generate "$@"
