import { SpanKind, trace, type Span } from "@opentelemetry/api";
import { getSource, sendGodeyeEvent } from "./config.js";

// Telemetria de jobs (BullMQ e afins). Abre um span-raiz ATIVO (godeye.kind=
// job-root) em volta do job pra as queries Prisma/postgres.js de dentro herdarem
// o trace e virarem db_query amarrados a este job. O span-raiz em si e descartado
// pelo exporter (o evento type:"job" e emitido a mao aqui — sem double-emit).
// Tipagem estrutural (MinimalJob) pra NAO acoplar em bullmq.
const tracer = trace.getTracer("godeye-worker");

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

export interface MinimalJob {
  name: string;
  queueName: string;
  id?: string | number;
  attemptsMade?: number;
}

export interface GodeyeJobOptions<J> {
  /**
   * Extrai o id do user que originou o job (ex: `j => j.data?.meta?.userId`).
   * Carimba `userId` no evento `job` — como os db_query do worker herdam o mesmo
   * traceId do job, o drawer resolve "quem foi" via traceId. Essencial pros apps
   * webhook-first (mistica/easyfit), onde o trabalho real roda no worker e o
   * setGodeyeUser do web nao alcanca. Nao lanca se o extractor falhar.
   */
  userId?: (job: J) => string | number | null | undefined;
}

export function godeyeJobWrapper<J extends MinimalJob, R>(
  processor: (job: J, token?: string) => Promise<R>,
  options?: GodeyeJobOptions<J>,
): (job: J, token?: string) => Promise<R> {
  return (job: J, token?: string): Promise<R> =>
    tracer.startActiveSpan(
      `job ${job.name}`,
      { kind: SpanKind.INTERNAL, attributes: { "godeye.kind": "job-root" } },
      async (rootSpan: Span): Promise<R> => {
        const sc = rootSpan.spanContext();
        const traceCtx =
          sc.traceId === INVALID_TRACE_ID || sc.spanId === INVALID_SPAN_ID
            ? undefined
            : { traceId: sc.traceId, spanId: sc.spanId };
        const start = Date.now();
        let status: "ok" | "error" = "ok";
        let errorMessage: string | undefined;
        let errorStack: string | undefined;
        try {
          return await processor(job, token);
        } catch (err) {
          status = "error";
          errorMessage = err instanceof Error ? err.message : String(err);
          errorStack = err instanceof Error ? err.stack : undefined;
          throw err;
        } finally {
          rootSpan.end();
          // userId de quem originou o job (extractor do consumidor). Nunca deixa
          // o extractor derrubar a emissao de telemetria.
          let userId: string | undefined;
          try {
            const u = options?.userId?.(job);
            if (u != null) userId = String(u);
          } catch {
            // extractor falhou — segue sem userId
          }
          sendGodeyeEvent({
            source: getSource(),
            type: "job",
            name: job.name,
            status,
            durationMs: Date.now() - start,
            userId,
            errorMessage,
            errorStack,
            traceId: traceCtx?.traceId,
            spanId: traceCtx?.spanId,
            metadata: {
              queue: job.queueName,
              jobId: job.id,
              attempts: (job.attemptsMade ?? 0) + 1,
            },
          });
        }
      },
    );
}
