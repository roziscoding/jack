import bencode from 'bencode'

export interface TorrentStubOptions {
  name: string
  size: number
  peerId: string
  itemId: string
}

export function createTorrentStub(options: TorrentStubOptions): Buffer {
  const pieceLength = 262144 // 256KB, doesn't matter for stub

  const torrent = {
    info: {
      name: Buffer.from(options.name),
      'piece length': pieceLength,
      length: options.size,
      pieces: Buffer.alloc(20), // dummy hash, not used
    },
    comment: Buffer.from(`jack:${options.peerId}:${options.itemId}`),
  }

  return Buffer.from(bencode.encode(torrent))
}

export function parseTorrentStub(data: Buffer): { peerId: string, itemId: string } | null {
  try {
    const torrent = bencode.decode(data) as any
    const raw = torrent.comment
    if (!raw) return null
    const comment = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw)
    if (!comment.startsWith('jack:')) return null

    const parts = comment.split(':')
    if (parts.length < 3) return null

    return {
      peerId: parts[1],
      itemId: parts.slice(2).join(':'),
    }
  } catch {
    return null
  }
}
