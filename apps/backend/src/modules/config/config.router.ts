import type { ConfigController } from './config.controller'
import { Hono } from 'hono'
import { describeRoute, validator as zValidator } from 'hono-openapi'
import { z } from 'zod'
import { RawDownloadsConfig, RawExternalJackConfig, RawJackConfig, RawPeerConfig, RawServerConfig } from '../../lib/config'
import { streamSnapshots } from '../../lib/sse'

const idParam = z.object({ id: z.string().min(1) })

function configDoc(summary: string, description?: string, status = 200) {
  return describeRoute({
    tags: ['Config'],
    summary,
    description,
    security: [{ 'X-Management-Key': [] }],
    responses: { [status]: { description: 'Success', content: { 'application/json': {} } } },
  })
}

export function getConfigRouter(controller: ConfigController) {
  const app = new Hono()

  app.get('/', configDoc('Get the full config', 'The loaded configuration with secrets redacted.'), c => c.json(controller.listConfig()))
  app.get('/peers', configDoc('List configured peers'), c => c.json(controller.listPeers()))
  app.get('/servers', configDoc('List configured servers'), c => c.json(controller.listServers()))
  app.get('/jack', configDoc('Get the jack block'), c => c.json(controller.getJack()))
  app.get('/downloads', configDoc('Get the downloads block', 'The persisted downloads config, or null when downloads are not configured.'), c => c.json(controller.getDownloads()))
  app.get('/stream', describeRoute({
    tags: ['Config'],
    summary: 'Stream connector config',
    description: 'Server-Sent Events stream with an initial connector snapshot and immediate updates when connector state changes.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live connector snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => controller.listConfig(), subscriber => controller.subscribe(subscriber)))

  // Mutation routes only exist when a ConfigService is wired in. Without one, these
  // paths are simply unregistered → 404 (rather than a 500 from an unconfigured call).
  if (controller.canMutate) {
    // `?force=true` persists the peer even if its handshake fails — it stays
    // resident and auto-retries lazily, instead of aborting + rolling back.
    app.post('/peers', configDoc('Add a peer', 'Persists a new peer and connects to it. `?force=true` keeps the peer even if its handshake fails; it auto-retries lazily.', 201), zValidator('json', RawPeerConfig), async (c) => {
      const force = c.req.query('force') === 'true'
      return c.json(await controller.addPeer(c.req.valid('json'), { force }), 201)
    })

    app.delete('/peers/:id', configDoc('Remove a peer'), zValidator('param', idParam), async (c) => {
      return c.json(await controller.removePeer(c.req.valid('param').id))
    })

    app.patch('/peers/:id', configDoc('Update a peer', 'Persists changes and reconnects. `?force=true` keeps the peer even if its handshake fails.'), zValidator('param', idParam), zValidator('json', RawPeerConfig), async (c) => {
      const force = c.req.query('force') === 'true'
      return c.json(await controller.updatePeer(c.req.valid('param').id, c.req.valid('json'), { force }))
    })

    app.post('/servers', configDoc('Add a Radarr/Sonarr server', undefined, 201), zValidator('json', RawServerConfig), async (c) => {
      return c.json(await controller.addServer(c.req.valid('json')), 201)
    })

    app.delete('/servers/:id', configDoc('Remove a server'), zValidator('param', idParam), async (c) => {
      return c.json(await controller.removeServer(c.req.valid('param').id))
    })

    app.patch('/servers/:id', configDoc('Update a server'), zValidator('param', idParam), zValidator('json', RawServerConfig), async (c) => {
      return c.json(await controller.updateServer(c.req.valid('param').id, c.req.valid('json')))
    })

    // jack has no connectivity check (boot-captured) → a successful PATCH just
    // persists; internalUrl is required, apiKey optional (RawJackConfig).
    app.patch('/jack', configDoc('Update the jack block', 'Persists the new values; they take effect on next boot (no connectivity check).'), zValidator('json', RawJackConfig), async (c) => {
      return c.json(await controller.updateJack(c.req.valid('json')))
    })

    app.patch('/jack/external', configDoc('Update external Jack access', 'Atomically replaces only the external access profile.'), zValidator('json', RawExternalJackConfig), async (c) => {
      return c.json(await controller.updateJackExternal(c.req.valid('json')))
    })

    app.delete('/jack/external', configDoc('Remove external Jack access', 'Atomically removes only the external access profile.'), async (c) => {
      return c.json(await controller.updateJackExternal(null))
    })

    // Partial patch: the body is merged onto the stored downloads block. Every knob
    // but `unlinkImportedFiles` is captured at boot, so those land on next restart.
    app.patch('/downloads', configDoc('Update the downloads block', 'Merges the given fields into the stored downloads config. `unlinkImportedFiles` applies immediately; the other values take effect on next boot.'), zValidator('json', RawDownloadsConfig), async (c) => {
      return c.json(await controller.updateDownloads(c.req.valid('json')))
    })
  }

  return app
}
