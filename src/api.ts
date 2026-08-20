import { setTimeout as sleep } from 'node:timers/promises'

import { API_BASE, MAX_RETRY_WAIT_SECONDS } from './config.ts'

import type { ApiError } from './types.ts'

export interface ApiOptions extends RequestInit {
  /** Caps how long a 429 is waited out, in seconds. */
  maxRetryWait?: number
}

/**
 * The single HTTP entry point. Past `maxRetryWait` a 429 is reported instead of waited out, so
 * the caller can decide — sleeping off a 24h backoff is never what anyone wants.
 */
export async function api<T>(token: string, path: string, options: ApiOptions = {}): Promise<T> {
  const { maxRetryWait = MAX_RETRY_WAIT_SECONDS, ...init } = options

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  })

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 2)
    if (retryAfter <= maxRetryWait) {
      await sleep((retryAfter + 1) * 1000)
      return api<T>(token, path, options)
    }
  }

  if (!response.ok) {
    const error: ApiError = new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${await response.text()}`)
    error.status = response.status
    throw error
  }

  return (response.status === 204 ? null : await response.json()) as T
}
