import { AppError } from './AppError'

interface Extras {
  body?: string
  method?: string
  headers?: {
    [key: string]: string
  }
  status?: number
  cause?: unknown
}

export class FetchError extends AppError {
  public readonly extras: Extras

  constructor(
    message: string,
    public readonly response: Response,
    { cause, ...extras }: Extras = {},
  ) {
    super(message, 'FETCH_ERROR', { cause })
    this.extras = extras
  }
}
