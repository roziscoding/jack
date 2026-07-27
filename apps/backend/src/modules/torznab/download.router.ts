import type { PeerConnector } from '../../lib/servers/peer'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { createTorrentStub } from './torrent'

const TORRENT_EXTENSION_REGEX = /\.torrent$/

export function getDownloadRouter(getPeers: () => PeerConnector[]) {
  const app = new Hono()

  app.get('/download/:id', describeRoute({
    tags: ['Torznab'],
    summary: 'Download a stub .torrent',
    description: 'Returns the stub `.torrent` for a release. The id is `peerId:itemId` (an optional `.torrent` suffix is stripped). The stub is bencoded data encoding just the peer and item — no trackers, no pieces — which *arr immediately hands back to the qBittorrent API to start the real HTTP transfer.',
    security: [{ apikey: [] }],
    responses: {
      200: { description: 'Stub torrent file', content: { 'application/x-bittorrent': {} } },
      400: { description: 'Id is not in peerId:itemId format' },
      404: { description: 'Unknown or uninitialized peer' },
    },
  }), async (c) => {
    const rawId = c.req.param('id').replace(TORRENT_EXTENSION_REGEX, '')
    const [peerId, ...itemParts] = rawId.split(':')
    const itemId = itemParts.join(':')

    if (!peerId || !itemId) {
      return c.json({ error: 'Invalid ID format, expected peerId:itemId' }, 400)
    }

    const peer = getPeers().find(p => p.id === peerId)
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
