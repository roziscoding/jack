import { AppError } from './AppError'

export class FetchError extends AppError {
  public readonly status: number | null

  constructor(message: string, public readonly response: Response, public readonly extras: { body?: string, method?: string, headers?: { [key: string]: string } } = {}) {
    super(`Fetch error: ${message}`, 'FETCH_ERROR')
    this.status = response.status ?? null
  }

  toJSON() {
    return {
      message: this.message,
      status: this.status,
      body: this.extras.body,
      method: this.extras.method,
      url: this.response.url,
      headers: this.extras.headers,
    }
  }
}
