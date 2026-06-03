// We only generate TypeScript types (no SDK client / zod): the *arr specs carry
// no operationIds (so generated SDK method names would be awkward) and the
// backend talks to Radarr/Sonarr through ServerConnector.fetch, which already
// handles X-Api-Key auth and error wrapping. The generated types let us mirror
// 100% of the movie/episode file metadata into a Release without hand-writing.
export default [
  {
    plugins: ['@hey-api/typescript'],
    input: './radarr.openapi.json',
    output: { path: './src/generated/radarr', entryFile: false },
  },
  {
    plugins: ['@hey-api/typescript'],
    input: './sonarr.openapi.json',
    output: { path: './src/generated/sonarr', entryFile: false },
  },
]
