import type { H3Event } from 'h3'

const SESSION_NAME = 'jack_management'

export type AuthMode = 'env' | 'cookie'

export interface ResolvedKey {
  key: string | null
  mode: AuthMode
}

interface SessionData {
  key?: string
}

// Secure cookie is driven by the forwarded proto so it works behind a reverse
// proxy (Traefik/Cloudflare) terminating TLS in front of the HTTP-only BFF.
function isSecure(event: H3Event): boolean {
  const forwarded = getRequestHeader(event, 'x-forwarded-proto')
  if (forwarded)
    return forwarded.split(',')[0]!.trim() === 'https'
  return getRequestProtocol(event) === 'https'
}

export function getManagementSession(event: H3Event) {
  const { sessionKey } = useRuntimeConfig(event)
  return useSession<SessionData>(event, {
    name: SESSION_NAME,
    // h3's `useSession` calls this option `password`; it's our session secret.
    password: sessionKey,
    cookie: {
      httpOnly: true,
      secure: isSecure(event),
      sameSite: 'strict',
      path: '/',
    },
  })
}

/**
 * Resolve the management key for this request. `env` mode: the BFF injects the
 * key from its own environment (browser never sees it). `cookie` mode: the key
 * comes from the sealed session cookie set at login (null until the user logs in).
 */
export async function resolveKey(event: H3Event): Promise<ResolvedKey> {
  const { managementKey } = useRuntimeConfig(event)
  if (managementKey)
    return { key: managementKey, mode: 'env' }

  const session = await getManagementSession(event)
  return { key: session.data.key ?? null, mode: 'cookie' }
}

export function upstreamUrl(event: H3Event, path: string): string {
  const { managementApiUrl } = useRuntimeConfig(event)
  return new URL(path, managementApiUrl).toString()
}

/**
 * CSRF defense for state-changing requests: the auto-sent cookie is paired with a
 * same-origin check. `SameSite=Strict` already blocks cross-site sends; this is
 * defense-in-depth against any request that does carry an Origin from elsewhere.
 */
export function assertSameOrigin(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin')
  if (!origin)
    return

  const host = getRequestHeader(event, 'host')
  let originHost: string
  try {
    originHost = new URL(origin).host
  }
  catch {
    throw createError({ statusCode: 403, statusMessage: 'invalid origin' })
  }

  if (!host || originHost !== host)
    throw createError({ statusCode: 403, statusMessage: 'cross-origin request rejected' })
}

/** Probe the upstream management API; a connection error means it's disabled. */
export async function probeUpstream(event: H3Event, key: string | null): Promise<{ reachable: boolean, status: number }> {
  try {
    const res = await fetch(upstreamUrl(event, '/ping'), {
      headers: key ? { 'X-Management-Key': key } : {},
    })
    return { reachable: true, status: res.status }
  }
  catch {
    return { reachable: false, status: 0 }
  }
}
