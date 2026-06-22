import { AppError } from './AppError'

export class BadRequestError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'BAD_REQUEST', { cause })
  }
}
