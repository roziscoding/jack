#!/usr/bin/env sh
#MISE description="Typecheck non-Vue workspace files with tsc"
# packages/schemas re-exports the generated (gitignored) clients, so they have to
# exist before tsc runs over the workspace. `clients:generate` skips the clean that
# `clients` does, so repeating it on every typecheck is cheap.
#MISE depends=["clients:generate"]

bunx tsc --project tsconfig.json --noEmit --pretty false
