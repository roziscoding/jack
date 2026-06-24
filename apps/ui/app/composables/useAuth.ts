export type AuthStatus = 'loading' | 'ok' | 'needs-key' | 'disabled' | 'error'
export type AuthMode = 'env' | 'cookie' | null

export interface AuthState {
  status: AuthStatus
  mode: AuthMode
  message?: string
}

interface PingResponse {
  status: Exclude<AuthStatus, 'loading'>
  mode: AuthMode
  message?: string
}

export function useAuthState() {
  return useState<AuthState>('auth', () => ({ status: 'loading', mode: null }))
}

export function useAuth() {
  const state = useAuthState()

  async function refresh(): Promise<void> {
    try {
      const res = await $fetch<PingResponse>('/api/ping')
      state.value = { status: res.status, mode: res.mode, message: res.message }
    }
    catch {
      state.value = { status: 'error', mode: null, message: 'Could not reach the UI server.' }
    }
  }

  async function login(key: string): Promise<void> {
    await $fetch('/api/login', { method: 'POST', body: { key } })
    await refresh()
  }

  async function logout(): Promise<void> {
    await $fetch('/api/logout', { method: 'POST' })
    await refresh()
  }

  return { state, refresh, login, logout }
}
