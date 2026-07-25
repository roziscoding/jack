import type { DownloadsManagementController } from './downloads.controller'
import { Hono } from 'hono'
import { BadRequestError } from '../../lib/errors/BadRequestError'

const POSITIVE_INTEGER_REGEX = /^[1-9]\d*$/

function numericId(raw: string): number {
  if (!POSITIVE_INTEGER_REGEX.test(raw))
    throw new BadRequestError('Download id must be a positive integer')
  const id = Number(raw)
  if (!Number.isSafeInteger(id))
    throw new BadRequestError('Download id must be a safe integer')
  return id
}

export function getDownloadsManagementRouter(controller: DownloadsManagementController) {
  const app = new Hono()
  app.post('/:id/cancel', async c => c.json(await controller.cancel(numericId(c.req.param('id')))))
  app.post('/:id/retry', async c => c.json(await controller.retry(numericId(c.req.param('id')))))
  app.delete('/:id', async c => c.json(await controller.delete(numericId(c.req.param('id')))))
  return app
}
