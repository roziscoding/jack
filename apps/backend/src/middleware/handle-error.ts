import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { accepts } from 'hono/accepts'
import { xml } from '../helpers/xml'
import { BadRequestError } from '../lib/errors/BadRequestError'
import { ConflictError } from '../lib/errors/ConflictError'
import { ConnectorInitializationError } from '../lib/errors/ConnectorInitializationError'
import { FetchError } from '../lib/errors/FetchError'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

const STATUS_CODE_MAP = [
  [UnauthorizedError, 401] as const,
  [BadRequestError, 400] as const,
  [ConflictError, 409] as const,
  [NotFoundError, 404] as const,
  [FetchError, 503] as const,
  // Upstream peer/server failed its connectivity check during an interactive add.
  [ConnectorInitializationError, 502] as const,
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
    const contentType = accepts(c, {
      default: 'application/json',
      header: 'Accept',
      supports: ['application/json', 'application/rss+xml', 'application/xml+rss', 'application/xml', 'text/xml'],
    })

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
      }, 500)
    }

    if (status === 401 && contentType !== 'application/json') {
      return xml(c, {
        error: {
          '@code': 100,
          '@description': error.message,
        },
      })
    }

    return c.json({
      ok: false,
      error,
    }, status)
  }
}
