import { AppError } from './AppError'

export class ConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFLICT', { cause })
  }
}
