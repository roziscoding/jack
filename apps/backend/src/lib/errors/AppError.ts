interface Options {
  cause: unknown
}

export class AppError extends Error {
  public override readonly message: string
  public override readonly cause: unknown

  constructor(
    message: string,
    public readonly code: string,
    options: Options,
  ) {
    super(message)
    this.message = message
    this.cause = options.cause
  }
}
