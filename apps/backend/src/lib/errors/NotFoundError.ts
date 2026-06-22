import { AppError } from './AppError'

export class NotFoundError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'NOT_FOUND', { cause })
  }
}
