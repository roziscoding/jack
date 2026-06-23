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
      if (status === 401)
        auth.value = { ...auth.value, status: 'needs-key' }
      throw error
    }
  }

  function extractError(error: unknown, fallback = 'Request failed'): string {
    const data = (error as { data?: { error?: { message?: string }, message?: string } })?.data
    return data?.error?.message ?? data?.message ?? (error as Error)?.message ?? fallback
  }

  return { request, extractError }
}
