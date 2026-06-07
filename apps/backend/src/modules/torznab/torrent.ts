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

// Shared so the served stub and the reported hash bencode the SAME info dict.
function buildStubInfo(name: string, size: number) {
  return {
    'name': Buffer.from(name),
    'piece length': PIECE_LENGTH,
    'length': size,
    'pieces': Buffer.alloc(getPieceCount(size) * SHA1_HASH_LENGTH),
  }
}

export function createTorrentStub(options: TorrentStubOptions): Buffer {
  const torrent = {
    info: buildStubInfo(options.name, options.size),
    comment: Buffer.from(`jack:${options.peerId}:${options.itemId}`),
  }
  return Buffer.from(bencode.encode(torrent))
}

/**
 * The stub's BitTorrent v1 infohash (lowercase 40-hex) = sha1(bencode(info)).
 * arr computes this same hash from the .torrent it grabbed and matches
 * torrents/info by it, so jack MUST report exactly this. bencode is
 * deterministic (sorted keys), so re-encoding the same info dict reproduces the
 * bytes *arr hashed.
 */
export function getStubInfoHash(name: string, size: number): string {
  return new Bun.CryptoHasher('sha1').update(bencode.encode(buildStubInfo(name, size))).digest('hex')
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
