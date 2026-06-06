import { getStubInfoHash } from '../torznab/torrent'

/**
 * The torrent's real BitTorrent infohash. jack has no peer wire, but *arr
 * computes this hash from the stub it grabbed and matches torrents/info by it,
 * so it MUST equal the served stub's infohash -- derive it from the same
 * (release title, size) the stub was built from, NOT from peerId:itemId.
 */
export function deriveHash(name: string, size: number): string {
  return getStubInfoHash(name, size)
}

/**
 * The qB category string jack assigns to a destination server. Unique per
 * server so two same-type *arr instances never see each other's torrents.
 */
export function qbCategoryForServer(serverId: string): string {
  return `jack-${serverId}`
}
