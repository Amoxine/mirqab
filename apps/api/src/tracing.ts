/**
 * OpenTelemetry bootstrap (WP20).
 *
 * Imported as the FIRST statement of `main.ts`, before `AppModule` — `HttpInstrumentation` patches
 * the `http`/`https` module exports, and `PrismaInstrumentation` installs the global tracing helper
 * that `@prisma/client` looks for when it builds its engine. Both are cheap no-ops when nothing
 * has been loaded yet and unreliable once Nest has created the server and Prisma its engine.
 *
 * Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so `pnpm test`, the `.mjs` e2e scripts and a
 * plain `pnpm dev` keep starting with no collector anywhere near them. In compose the endpoint is
 * `http://otel-collector:4318` (HTTP/protobuf — the gRPC exporter would pull a native dependency
 * into an alpine image for no gain here).
 *
 * The chain this exists to produce is gateway -> api -> postgres: Tyk sends a `traceparent`,
 * `HttpInstrumentation` continues that trace for the incoming request, and `PrismaInstrumentation`
 * hangs the `prisma:engine:db_query` span under it. Prisma 6.19 emits those spans with no
 * `previewFeatures` entry — tracing is GA (verified against this repo's 6.19.3 client).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // Two sources of pure noise, and /api/health cannot simply be dropped like /api/metrics:
        // it is the upstream of the fixture API that proves the gateway -> api -> postgres chain.
        // The distinction that works is whether the probe is already part of a trace — the Docker
        // HEALTHCHECK arrives with no `traceparent` and would otherwise start a fresh 8-span trace
        // every 30 s forever, while the same URL reached through the gateway always carries one.
        ignoreIncomingRequestHook: (req) =>
          (req.url?.startsWith('/api/metrics') ?? false) ||
          ((req.url?.startsWith('/api/health') ?? false) && req.headers.traceparent === undefined),
      }),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();

  // Flush the batch processor on shutdown; without this the last few seconds of spans are dropped
  // on every `docker compose restart api`.
  process.once('SIGTERM', () => {
    void sdk.shutdown();
  });
}
