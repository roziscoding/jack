import type { PeerConnector } from '../../lib/servers/peer'
import { Hono } from 'hono'
import { createTorrentStub } from './torrent'

const TORRENT_EXTENSION_REGEX = /\.torrent$/

export function getDownloadRouter(peers: PeerConnector[]) {
  const app = new Hono()

  app.get('/download/:id', async (c) => {
    const rawId = c.req.param('id').replace(TORRENT_EXTENSION_REGEX, '')
    const [peerId, ...itemParts] = rawId.split(':')
    const itemId = itemParts.join(':')

    if (!peerId || !itemId) {
      return c.json({ error: 'Invalid ID format, expected peerId:itemId' }, 400)
    }

    const peer = peers.find(p => p.id === peerId)
    if (!peer || !peer.isInitialized) {
      return c.json({ error: 'Peer not found or not initialized' }, 404)
    }

    const item = await peer.getRelease(itemId)
    const name = item.title
    const size = item.size

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
