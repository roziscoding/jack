import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { getAppEnvs, isOtelEnabled } from './lib/envs'
import { logger } from './logger'

// Must be imported before anything that handles requests so the global tracer
// and logger providers are registered before the first span/log is created.
// `index.ts` imports this module first for exactly that reason.

const envs = getAppEnvs()

let sdk: NodeSDK | null = null

if (isOtelEnabled(envs)) {
  sdk = new NodeSDK({
    serviceName: envs.OTEL_SERVICE_NAME,
    // Simple (non-batching) processors: every span/log is exported immediately
    // instead of waiting for a batch interval. The OTLP/HTTP exporters read
    // OTEL_EXPORTER_OTLP_ENDPOINT (or the signal-specific *_TRACES_ENDPOINT /
    // *_LOGS_ENDPOINT) from the environment, posting to /v1/traces and /v1/logs.
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter())],
    // Registers the global logger provider. The pino->OTel bridge in logger.ts
    // feeds it (see logger.ts); NodeSDK.shutdown() flushes it on exit.
    logRecordProcessors: [new SimpleLogRecordProcessor(new OTLPLogExporter())],
    // Spans are created explicitly by the @hono/otel middleware, so no
    // auto-instrumentation is needed — and skipping it avoids the module
    // monkey-patching that doesn't play well under Bun.
    instrumentations: [],
  })

  sdk.start()
  logger.info({ serviceName: envs.OTEL_SERVICE_NAME }, 'OpenTelemetry tracing and logs enabled')
}

/**
 * Flush and shut down the tracer + logger providers so the last batch of spans
 * and logs isn't lost on exit. No-op when tracing is disabled. Wired into the
 * process signal handlers in `index.ts`.
 */
export async function shutdownTelemetry() {
  if (!sdk)
    return
  try {
    await sdk.shutdown()
  }
  catch (err) {
    logger.error({ err }, 'Error shutting down OpenTelemetry')
  }
}
