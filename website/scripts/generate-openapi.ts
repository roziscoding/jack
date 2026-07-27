import type { AppConfig } from '../../apps/backend/src/lib/config'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { getApp } from '../../apps/backend/src/app'
import { getAppEnvs } from '../../apps/backend/src/lib/envs'
// generateSpecs comes through the backend's openapi module on purpose: it must
// be the same hono-openapi instance the routers used, or the specs come out empty.
import { generateSpecs, managementDocumentation, peerDocumentation } from '../../apps/backend/src/lib/openapi'
import { getManagementApp } from '../../apps/backend/src/management-app'

// Builds both backend apps with inert dependencies and writes their OpenAPI
// specs to public/openapi/, where the website serves them. Route handlers never
// run during generation, so controllers and repositories can be empty stubs —
// no config file, database, or *arr needed. Run with NODE_ENV=test (the
// generate:openapi script does) so the backend logger and its file sink stay
// disabled.
const stub = <T>() => ({} as T)

const config = {
  jack: { internalUrl: 'http://localhost:5225' },
  downloads: { completedPath: '/tmp/jack-openapi' },
  servers: [],
  peers: [],
} as unknown as AppConfig

const connectors = { servers: [], peers: [] }

const peerApp = getApp(getAppEnvs(), config, connectors, {
  apiKeysRepository: stub(),
  managedKeysRepository: stub(),
  downloadsRepository: stub(),
  downloadsService: stub(),
})

const managementApp = getManagementApp({
  environment: 'test',
  managementKey: 'openapi-generation',
  connectors,
  // Present so the conditional mutation and api-key routes are registered.
  configService: stub(),
  downloadsRepository: stub(),
  downloadsService: stub(),
  apiKeysRepository: stub(),
})

const peerSpec = await generateSpecs(peerApp, { documentation: peerDocumentation })
const managementSpec = await generateSpecs(managementApp, { documentation: managementDocumentation })

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/openapi')
await mkdir(outDir, { recursive: true })
await Bun.write(resolve(outDir, 'peer.json'), `${JSON.stringify(peerSpec, null, 2)}\n`)
await Bun.write(resolve(outDir, 'management.json'), `${JSON.stringify(managementSpec, null, 2)}\n`)

console.log(`OpenAPI specs written to ${outDir}/{peer,management}.json`)

// The imported backend modules hold open handles (log hub timers, etc.) that
// would otherwise keep the process alive.
process.exit(0)
