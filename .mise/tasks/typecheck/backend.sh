#!/usr/bin/env sh
#MISE description="Typecheck the backend with tsc"
# The backend imports @jack/schemas, whose sources are generated and gitignored —
# without this, a fresh checkout fails with "Cannot find module '@jack/schemas/...'".
# `clients:generate` rather than `clients`: it skips the clean, so it's idempotent
# and cheap to repeat on every typecheck.
#MISE depends=["clients:generate"]

bunx tsc --project apps/backend/tsconfig.json --noEmit --pretty false
