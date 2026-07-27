import type { GenerateSpecOptions } from 'hono-openapi'
import { PROTOCOL_VERSION } from './version'

// Re-exported for the website's spec-generation script: describeRoute tags
// routes with a module-private Symbol, so specs only come out non-empty when
// generateSpecs comes from the exact same hono-openapi instance the routers
// imported. Going through this file guarantees that.
export { generateSpecs } from 'hono-openapi'

export const peerDocumentation: GenerateSpecOptions['documentation'] = {
  info: {
    title: 'jack peer API',
    version: PROTOCOL_VERSION,
    description: 'The external surface of a jack instance: the peer API other jacks consume, plus the Torznab indexer and qBittorrent download-client APIs the operator\'s Radarr/Sonarr talk to.',
  },
  servers: [
    { url: 'http://localhost:5225', description: 'Default local port (PORT)' },
  ],
  components: {
    securitySchemes: {
      'X-Api-Key': {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        description: 'Peer API key issued by this instance\'s operator. Scoped to /handshake and /peer/*.',
      },
      'apikey': {
        type: 'apiKey',
        in: 'query',
        name: 'apikey',
        description: 'Managed key jack auto-registered in Radarr/Sonarr. Scoped to /torznab/*. Also accepted as the X-Api-Key header.',
      },
      'SID': {
        type: 'apiKey',
        in: 'cookie',
        name: 'SID',
        description: 'qBittorrent WebUI session cookie obtained from /api/v2/auth/login.',
      },
    },
  },
  tags: [
    { name: 'System', description: 'Health and identity probes.' },
    { name: 'Peer', description: 'Endpoints other jack instances call to search this library and download files from it.' },
    { name: 'Torznab', description: 'Torznab indexer API the operator\'s Radarr/Sonarr search through. Responses are XML per the Torznab spec.' },
    { name: 'qBittorrent', description: 'qBittorrent WebUI API subset Radarr/Sonarr use to hand grabs to jack and poll their progress.' },
  ],
}

export const managementDocumentation: GenerateSpecOptions['documentation'] = {
  info: {
    title: 'jack management API',
    version: PROTOCOL_VERSION,
    description: 'Operator-facing API on a separate listener from the public peer port. Drives the management UI: config, status, downloads, logs, catalog, and API keys.',
  },
  servers: [
    { url: 'http://localhost:5226', description: 'Default local management port (MANAGEMENT_PORT)' },
  ],
  components: {
    securitySchemes: {
      'X-Management-Key': {
        type: 'apiKey',
        in: 'header',
        name: 'X-Management-Key',
        description: 'The JACK_MANAGEMENT_KEY the management listener was started with.',
      },
    },
  },
  tags: [
    { name: 'System', description: 'Health and identity probes.' },
    { name: 'Config', description: 'Read and mutate the persisted jack/servers/peers configuration.' },
    { name: 'Status', description: 'Connector and download overviews.' },
    { name: 'Downloads', description: 'Manage individual download records by their numeric id.' },
    { name: 'Logs', description: 'Backfill and live-tail the process\'s own logs.' },
    { name: 'Catalog', description: 'Aggregated peer catalog and TMDB-backed metadata for the UI.' },
    { name: 'API keys', description: 'Issue, list, and revoke the peer API keys this instance hands out.' },
  ],
}
