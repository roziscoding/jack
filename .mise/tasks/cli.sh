#!/usr/bin/env sh
#MISE description="Talk to a running jack (scripts/cli.ts). Reads JACK_URL / JACK_API_KEY."
#MISE quiet=true

bun scripts/cli.ts "$@"
