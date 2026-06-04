# @jack/schemas

Generated TypeScript types for the Radarr and Sonarr API schemas used by
`@jack/backend`.

This package intentionally exports types only. The backend still performs its
own connector requests so it can centralize auth headers, timeouts, error
wrapping, and tracing.

## Exports

- `@jack/schemas/radarr/types`
- `@jack/schemas/sonarr/types`
- `@jack/schemas` namespace exports for both sets

## Regenerating

From the repo root:

```bash
mise run clients
```

That runs `openapi-ts` against the checked-in `radarr.openapi.json` and
`sonarr.openapi.json`, writing generated files under `src/generated`.

To refresh the checked-in specs first:

```bash
bun run --cwd packages/schemas fetch-specs
mise run clients
```
