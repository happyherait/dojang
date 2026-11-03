import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/** OTEL_EXPORTER_OTLP_ENDPOINT가 있을 때만 추적을 내보낸다. */
export function startTelemetry(): () => Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => undefined;
  const sdk = new NodeSDK({ serviceName: 'dojang-api', traceExporter: new OTLPTraceExporter() });
  sdk.start();
  return () => sdk.shutdown();
}
