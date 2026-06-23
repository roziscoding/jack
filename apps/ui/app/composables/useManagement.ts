import type { NitroFetchOptions } from 'nitropack'

/**
 * Thin wrapper over the BFF proxy. Every data call routes through
 * `/api/management/*`; a 401 flips the global auth state back to the login gate.
 */
export function useManagement() {
  const auth = useAuthState()

  async function request<T>(path: string, opts: NitroFetchOptions<string> = {}): Promise<T> {
    try {
      return await $fetch<T>(`/api/management/${path}`, opts) as T
    }
    catch (error) {
      const status = (error as { response?: { status?: number }, statusCode?: number })?.response?.status
        ?? (error as { statusCode?: number })?.statusCode
      if (status === 401) {
        // In env-inject mode a 401 means the injected key was rejected — prompting
        // for a key the operator can't change from the browser is useless, so show
        // the error screen. In cookie mode it means the session lapsed → login gate.
        auth.value = auth.value.mode === 'env'
          ? { ...auth.value, status: 'error', message: 'The management key configured for the UI was rejected by the management API.' }
          : { ...auth.value, status: 'needs-key' }
      }
      throw error
    }
  }

  function extractError(error: unknown, fallback = 'Request failed'): string {
    const data = (error as { data?: { error?: { message?: string }, message?: string } })?.data
    return data?.error?.message ?? data?.message ?? (error as Error)?.message ?? fallback
  }

  return { request, extractError }
}
