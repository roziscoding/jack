import type { JackServerConnector } from '../../lib/servers/sources/jack'
import { Hono } from 'hono'
import { createTorrentStub } from './torrent'

export function getDownloadRouter(peers: JackServerConnector[], apiKey: string) {
  const app = new Hono()

  app.get('/download/:id', async (c) => {
    const key = c.req.query('apikey')
    if (key !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const rawId = c.req.param('id').replace(/\.torrent$/, '')
    const [peerId, ...itemParts] = rawId.split(':')
    const itemId = itemParts.join(':')

    if (!peerId || !itemId) {
      return c.json({ error: 'Invalid ID format, expected peerId:itemId' }, 400)
    }

    const peer = peers.find(p => p.id === peerId)
    if (!peer || !peer.isInitialized) {
      return c.json({ error: 'Peer not found or not initialized' }, 404)
    }

    const item = await peer.getItemMetadata(itemId)
    const name = item.Name ?? 'Unknown'
    const size = item.MediaSources?.[0]?.Size ?? 0

    const torrentData = createTorrentStub({ name, size, peerId, itemId })

    return new Response(torrentData, {
      headers: {
        'Content-Type': 'application/x-bittorrent',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.torrent"`,
        'Content-Length': String(torrentData.length),
      },
    })
  })

  return app
}
