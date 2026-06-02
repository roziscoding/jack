import { join } from 'node:path'

export interface TestEnv {
  radarrUrl: string
  radarrApiKey: string
  sonarrUrl: string
  sonarrApiKey: string
  jackAlphaUrl: string
  jackAlphaApiKey: string
  jackBetaUrl: string
  jackBetaApiKey: string
}

const TEST_ENV_PATH = join(import.meta.dir, 'config', 'test-env.json')

export async function getTestEnv(): Promise<TestEnv> {
  return Bun.file(TEST_ENV_PATH).json()
}

export async function waitForUrl(url: string, opts?: { timeout?: number, interval?: number }): Promise<void> {
  const timeout = opts?.timeout ?? 120_000
  const interval = opts?.interval ?? 2_000
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await Bun.sleep(interval)
  }

  throw new Error(`Timed out waiting for ${url} after ${timeout}ms`)
}

export async function retry<T>(fn: () => Promise<T>, opts?: { retries?: number, delay?: number }): Promise<T> {
  const retries = opts?.retries ?? 10
  const delay = opts?.delay ?? 2_000
  let lastError: Error | undefined

  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (i < retries - 1) await Bun.sleep(delay)
    }
  }

  throw lastError
}

export async function fetchJson<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${url}${body ? ` — ${body.slice(0, 500)}` : ''}`)
  }
  return res.json() as Promise<T>
}
