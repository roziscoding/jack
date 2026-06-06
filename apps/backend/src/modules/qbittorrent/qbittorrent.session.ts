export interface QbSession {
  serverName: string
  serverId: string
}

const SESSION_TTL_MS = 60 * 60 * 1000 // 1h, refreshed on each successful login

export class QbSessionStore {
  private readonly sessions = new Map<string, { session: QbSession, expiresAt: number }>()

  create(session: QbSession): string {
    // Sweep expired entries on each login so abandoned SIDs don't accumulate
    // (get() only evicts lazily on access). Logins are infrequent, so the O(n)
    // pass is cheap.
    this.sweep()
    const sid = new Bun.CryptoHasher('sha256').update(crypto.randomUUID()).digest('hex')
    this.sessions.set(sid, { session, expiresAt: Date.now() + SESSION_TTL_MS })
    return sid
  }

  private sweep(): void {
    const now = Date.now()
    for (const [sid, entry] of this.sessions) {
      if (entry.expiresAt < now)
        this.sessions.delete(sid)
    }
  }

  get(sid: string | undefined): QbSession | null {
    if (!sid)
      return null
    const entry = this.sessions.get(sid)
    if (!entry)
      return null
    if (entry.expiresAt < Date.now()) {
      this.sessions.delete(sid)
      return null
    }
    return entry.session
  }

  delete(sid: string | undefined): void {
    if (sid)
      this.sessions.delete(sid)
  }
}
