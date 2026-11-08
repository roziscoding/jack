export type UploadOutcome = 'completed' | 'aborted' | 'failed'

export interface ByteCountingHooks {
  /** Called after every chunk with the running total. */
  onProgress: (sentBytes: number) => void
  /** Called exactly once, when the body was fully read, cancelled, or failed. */
  onEnd: (outcome: UploadOutcome, sentBytes: number, error: string | null) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : String(err)
}

/**
 * Wraps a file body in a stream that counts the bytes handed to the consumer.
 *
 * The stream is pull-based with a zero high-water mark: a chunk is read from
 * disk only when the consumer asks for one, so a stalled peer still holds the
 * read back instead of buffering the file in memory. A cancel from the consumer
 * or an abort on `signal` (the peer disconnected) ends it as `aborted`.
 */
export function countBytes(body: Blob, hooks: ByteCountingHooks, signal?: AbortSignal): ReadableStream<Uint8Array> {
  // Opened on the first pull, so a file that vanished since the existence check
  // fails the stream (and ends as `failed`) instead of throwing here.
  const openReader = () => body.stream().getReader()
  let reader: ReturnType<typeof openReader> | undefined
  let sentBytes = 0
  let ended = false

  const end = (outcome: UploadOutcome, error: string | null = null) => {
    if (ended)
      return
    ended = true
    signal?.removeEventListener('abort', onAbort)
    hooks.onEnd(outcome, sentBytes, error)
  }

  function onAbort() {
    end('aborted', 'peer disconnected')
    reader?.cancel().catch(() => {})
  }

  if (signal?.aborted)
    onAbort()
  else
    signal?.addEventListener('abort', onAbort, { once: true })

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        reader ??= openReader()
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          end('completed')
          return
        }
        sentBytes += value.byteLength
        controller.enqueue(value)
        hooks.onProgress(sentBytes)
      }
      catch (err) {
        end('failed', errorMessage(err))
        controller.error(err)
      }
    },
    async cancel(reason) {
      end('aborted', reason === undefined
        ? 'peer disconnected'
        : errorMessage(reason))
      await reader?.cancel(reason).catch(() => {})
    },
  }, { highWaterMark: 0 })
}
