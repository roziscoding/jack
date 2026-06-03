import { Buffer } from 'node:buffer'
import bencode from 'bencode'

const PIECE_LENGTH = 16 * 1024 * 1024 // 16MiB keeps stubs small while staying torrent-parser friendly.
const SHA1_HASH_LENGTH = 20

export interface TorrentStubOptions {
  name: string
  size: number
  peerId: string
  itemId: string
}

function getPieceCount(size: number): number {
  if (size <= 0)
    return 0

  return Math.ceil(size / PIECE_LENGTH)
}

export function createTorrentStub(options: TorrentStubOptions): Buffer {
  const pieces = Buffer.alloc(getPieceCount(options.size) * SHA1_HASH_LENGTH)

  const torrent = {
    info: {
      'name': Buffer.from(options.name),
      'piece length': PIECE_LENGTH,
      'length': options.size,
      'pieces': pieces, // Dummy hashes. Radarr validates count/shape before writing to blackhole.
    },
    comment: Buffer.from(`jack:${options.peerId}:${options.itemId}`),
  }

  return Buffer.from(bencode.encode(torrent))
}

export function parseTorrentStub(data: Buffer): { peerId: string, itemId: string } | null {
  try {
    const torrent = bencode.decode(data) as any
    const raw = torrent.comment
    if (!raw)
      return null
    const comment = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw)
    if (!comment.startsWith('jack:'))
      return null

    const [, peerId, ...itemParts] = comment.split(':')
    const itemId = itemParts.join(':')
    if (!peerId || !itemId)
      return null

    return { peerId, itemId }
  }
  catch {
    return null
  }
}
