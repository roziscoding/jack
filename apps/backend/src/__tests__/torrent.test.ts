import { Buffer } from 'node:buffer'
import bencode from 'bencode'
import { describe, expect, test } from 'bun:test'
import { createTorrentStub, parseTorrentStub } from '../modules/torznab/torrent'

describe('Torrent stub', () => {
  test('createTorrentStub creates valid bencode', () => {
    const data = createTorrentStub({
      name: 'Test Movie.mkv',
      size: 1500000000,
      peerId: 'abc12345',
      itemId: 'item-uuid-123',
    })

    expect(data).toBeInstanceOf(Buffer)
    expect(data.length).toBeGreaterThan(0)
  })

  test('createTorrentStub emits one SHA1 hash per advertised piece', () => {
    const pieceLength = 16 * 1024 * 1024
    const size = pieceLength * 4 + 1
    const data = createTorrentStub({
      name: 'Large Movie.mkv',
      size,
      peerId: 'abc12345',
      itemId: 'item-uuid-123',
    })

    const torrent = bencode.decode(data) as any
    const pieces = torrent.info.pieces as Uint8Array

    expect(torrent.info['piece length']).toBe(pieceLength)
    expect(pieces.byteLength).toBe(Math.ceil(size / pieceLength) * 20)
  })

  test('parseTorrentStub extracts peer and item IDs', () => {
    const data = createTorrentStub({
      name: 'Test Movie.mkv',
      size: 1500000000,
      peerId: 'abc12345',
      itemId: 'item-uuid-123',
    })

    const result = parseTorrentStub(data)
    expect(result).not.toBeNull()
    expect(result!.peerId).toBe('abc12345')
    expect(result!.itemId).toBe('item-uuid-123')
  })

  test('parseTorrentStub handles item IDs with colons', () => {
    const data = createTorrentStub({
      name: 'Test.mkv',
      size: 100,
      peerId: 'peer1',
      itemId: 'item:with:colons',
    })

    const result = parseTorrentStub(data)
    expect(result).not.toBeNull()
    expect(result!.peerId).toBe('peer1')
    expect(result!.itemId).toBe('item:with:colons')
  })

  test('parseTorrentStub returns null for invalid data', () => {
    const result = parseTorrentStub(Buffer.from('not a torrent'))
    expect(result).toBeNull()
  })

  test('parseTorrentStub returns null for non-jack torrent', () => {
    const data = Buffer.from(bencode.encode({
      info: { 'name': Buffer.from('test'), 'piece length': 256, 'length': 100, 'pieces': Buffer.alloc(20) },
      comment: Buffer.from('not-jack-format'),
    }))

    const result = parseTorrentStub(data)
    expect(result).toBeNull()
  })
})
