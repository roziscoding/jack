#!/usr/bin/env sh
#MISE description="Run the management UI dev server (Nuxt). Reads JACK_MANAGEMENT_API_URL / JACK_MANAGEMENT_KEY."

# Config (all optional in dev — defaults live in apps/ui/nuxt.config.ts; overridden
# at runtime via these JACK_-prefixed env vars):
#   JACK_MANAGEMENT_API_URL  where the jack management API listens (default http://localhost:5226)
#   JACK_MANAGEMENT_KEY      set → inject mode (no browser prompt); unset → cookie prompt
#   JACK_SESSION_KEY         secret sealing the cookie in cookie mode (>= 32 chars; set in prod)
#
# Export them in your shell, pass inline (JACK_MANAGEMENT_KEY=… mise run ui), or
# drop them in apps/ui/.env (gitignored).

bun run --cwd apps/ui dev "$@"
