import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { FetchError } from '../lib/errors/FetchError'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

const STATUS_CODE_MAP = [
  [UnauthorizedError, 401] as const,
  [FetchError, 503] as const,
]

function getStatusCode<T>(error: T): ContentfulStatusCode | null {
  for (const [ErrorClass, statusCode] of STATUS_CODE_MAP) {
    if (error instanceof ErrorClass) {
      return statusCode
    }
  }

  return null
}

export function handleError(environment: string) {
  return (error: Error, c: Context) => {
    const status = getStatusCode(error)

    if (!status) {
      const payload = environment === 'development'
        ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause }
        : { message: 'An unexpected server error occured while processing your request' }

      return c.json({
        ok: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          ...payload,
        },
      })
    }

    return c.json({
      ok: false,
      error,
    }, status)
  }
}
