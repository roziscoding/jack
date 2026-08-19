import type { QuickLinksController } from './quick-links.controller'
import { Hono } from 'hono'
import { describeRoute, validator as zValidator } from 'hono-openapi'
import { CreateQuickLinkBody } from './quick-links.schema'

export function getQuickLinksRouter(controller: QuickLinksController) {
  const app = new Hono()

  app.post('/', describeRoute({
    tags: ['Quick links'],
    summary: 'Generate a peer quick link',
    description: 'Resolves the configured external access profile, issues a fresh revocable API key, and returns a ready-to-share quick link. The link contains credentials and is returned only once.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 201: { description: 'Quick link generated', content: { 'application/json': {} } } },
  }), zValidator('json', CreateQuickLinkBody), (c) => {
    const result = controller.create(c.req.valid('json'))
    c.header('Cache-Control', 'no-store')
    return c.json(result, 201)
  })

  return app
}
