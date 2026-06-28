import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { accepts } from 'hono/accepts'
import { xml } from '../helpers/xml'
import { AppError } from '../lib/errors/AppError'
import { BadRequestError } from '../lib/errors/BadRequestError'
import { ConflictError } from '../lib/errors/ConflictError'
import { ConnectorInitializationError } from '../lib/errors/ConnectorInitializationError'
import { FetchError } from '../lib/errors/FetchError'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'
import { redactObject } from '../lib/redact'

const STATUS_CODE_MAP = [
  [UnauthorizedError, 401] as const,
  [BadRequestError, 400] as const,
  [ConflictError, 409] as const,
  [NotFoundError, 404] as const,
  [FetchError, 503] as const,
  // Upstream peer/server failed its connectivity check during an interactive add.
  [ConnectorInitializationError, 502] as const,
]

// Generic, detail-free reason phrases for the opaque (peer-facing) responses.
// The point of opacity is that the body reveals nothing about our peers,
// servers, upstreams, or internals — so we never echo the thrown message,
// which routinely interpolates peer/server names, URLs, and upstream output.
const GENERIC_MESSAGE_BY_STATUS: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  404: 'Not found',
  409: 'Conflict',
  502: 'Bad gateway',
  503: 'Service unavailable',
}

const GENERIC_INTERNAL_MESSAGE = 'An unexpected server error occured while processing your request'

function getStatusCode<T>(error: T): ContentfulStatusCode | null {
  for (const [ErrorClass, statusCode] of STATUS_CODE_MAP) {
    if (error instanceof ErrorClass) {
      return statusCode
    }
  }

  return null
}

interface HandleErrorOptions {
  // When false (the default, used by the peer-facing API), error responses are
  // reduced to an opaque body — a stable machine-readable `code` plus a generic
  // reason phrase — so other peers and *arr clients can learn nothing about our
  // peers, servers, upstreams, or internals. When true (the management API,
  // which is key-guarded and serves the admin UI), the full error detail is
  // exposed. Either way every serialized error is run through `redactObject`,
  // so credentials (auth/cookie/token headers carried on FetchError.extras) are
  // masked before they leave the process.
  exposeDetails?: boolean
}

export function handleError(environment: string, { exposeDetails = false }: HandleErrorOptions = {}) {
  return (error: Error, c: Context) => {
    const status = getStatusCode(error)
    const contentType = accepts(c, {
      default: 'application/json',
      header: 'Accept',
      supports: ['application/json', 'application/rss+xml', 'application/xml+rss', 'application/xml', 'text/xml'],
    })

    if (!status) {
      const payload = exposeDetails && environment === 'development'
        ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause }
        : { message: GENERIC_INTERNAL_MESSAGE }

      return c.json(redactObject({
        ok: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          ...payload,
        },
      }), 500)
    }

    if (status === 401 && contentType !== 'application/json') {
      return xml(c, {
        error: {
          '@code': 100,
          '@description': exposeDetails ? error.message : (GENERIC_MESSAGE_BY_STATUS[401] ?? 'Unauthorized'),
        },
      })
    }

    if (!exposeDetails) {
      return c.json({
        ok: false,
        error: {
          code: error instanceof AppError ? error.code : 'ERROR',
          message: GENERIC_MESSAGE_BY_STATUS[status] ?? 'Request failed',
        },
      }, status)
    }

    return c.json(redactObject({
      ok: false,
      error,
    }), status)
  }
}
