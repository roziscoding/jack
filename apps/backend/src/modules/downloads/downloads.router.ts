import type { DownloadsManagementController } from './downloads.controller'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
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

const downloadsDoc = (summary: string, description: string) => describeRoute({
  tags: ['Downloads'],
  summary,
  description,
  security: [{ 'X-Management-Key': [] }],
  responses: {
    200: { description: 'The updated download record', content: { 'application/json': {} } },
    400: { description: 'Id is not a positive integer' },
  },
})

export function getDownloadsManagementRouter(controller: DownloadsManagementController) {
  const app = new Hono()
  app.post('/:id/cancel', downloadsDoc('Cancel a download', 'Stops the active transfer and preserves its `.part` file for a later retry.'), async c => c.json(await controller.cancel(numericId(c.req.param('id')))))
  app.post('/:id/retry', downloadsDoc('Retry a download', 'Repeats the last failed operation; transfers resume from the partial file, failed imports retry without re-downloading.'), async c => c.json(await controller.retry(numericId(c.req.param('id')))))
  app.delete('/:id', downloadsDoc('Delete a download', 'Cancels any active work, removes the history row, and deletes its unshared partial or completed artifacts.'), async c => c.json(await controller.delete(numericId(c.req.param('id')))))
  return app
}
