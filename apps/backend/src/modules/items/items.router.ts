import type { ItemsController } from './items.controller'
import { Hono } from 'hono'
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi'
import z from 'zod'

export function getItemsRouter(controller: ItemsController) {
  const app = new Hono()

  app.get(
    '/',
    describeRoute(
      {
        summary: 'Search for items',
        description: 'Search for items on all available sources',
        tags: ['items'],
        responses: {
          200: {
            description: 'Search results',
            content: {
              'application/json': {
                schema: resolver(z.array(z.object({
                  name: z.string(),
                  items: z.unknown(),
                }))),
              },
            },
          },
        },
      },
    ),
    zValidator('query', z.object({ searchTerm: z.string().optional().default('') })),
    async (c) => {
      const { searchTerm } = c.req.valid('query')

      const results = await controller.searchItems(searchTerm)

      return c.json(results)
    },
  )

  return app
}
