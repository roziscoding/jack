import process from 'node:process'
import { Hono } from 'hono'
import { UnauthorizedError } from './src/lib/errors/UnauthorizedError'
import { handleError } from './src/middleware/handle-error'

const app = new Hono()

app.get('/auth', () => {
  throw new UnauthorizedError('Invalid API Key', 'api key expired')
})

app.get('/generic', () => {
  throw new Error('Generic error')
})

app.onError(handleError(process.env.ENVIRONMENT ?? 'development'))

export default app
