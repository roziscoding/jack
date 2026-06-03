import { AppError } from './AppError'

export class UnauthorizedError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(`Unauthorized: ${message}`, 'UNAUTHORIZED', { cause })
  }
}
