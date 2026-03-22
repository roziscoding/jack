import { createClient } from './generated/jellyfin/client/client.gen'
import { Sdk } from './generated/jellyfin/sdk.gen'
export * as schemas from './generated/jellyfin/zod.gen'

export function createJellyfinClient(baseUrl: string, apiKey: string) {
  const client = createClient({ baseUrl, auth: `MediaBrowser Token="${apiKey}", Device="Jack"` })
  return new Sdk({ client })
}
