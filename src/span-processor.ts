import { SpanKind, type Span } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { IncomingMessage, ClientRequest } from "node:http";

import { getSource, sendGodeyeBatch, type GodeyePayload } from "./config.js";
import { enrichByTrace, setTraceEnrichment } from "./user-context.js";

// ── requestHook do HttpInstrumentation ────────────────────────────────────────
// Captura clientIp/userAgent do IncomingMessage cru (o SERVER span do Next nao
// expoe headers) e guarda por traceId pro exporter consumir no export().
export function godeyeRequestHook(
  span: Span,
  request: IncomingMessage | ClientRequest,
): void {
  const kind = (span as unknown as { kind?: SpanKind }).kind;
  if (kind !== SpanKind.SERVER) {
    return;
  }
  if (!("headers" in request) || !("socket" in request)) {
    return;
  }

  const h = request.headers;
  const xff = h["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  const clientIp =
    xffStr?.split(",")[0]?.trim() ||
    (h["x-real-ip"] as string | undefined) ||
    (h["cf-connecting-ip"] as string | undefined) ||
    (h["fly-client-ip"] as string | undefined) ||
    request.socket?.remoteAddress ||
    undefined;
  const userAgent = h["user-agent"] as string | undefined;

  setTraceEnrichment(span.spanContext().traceId, { clientIp, userAgent });
}

// ── helpers puros ──────────────────────────────────────────────────────────────
function hrToMs(start: [number, number], end: [number, number]): number {
  return Math.round(
    end[0] * 1000 + end[1] / 1e6 - (start[0] * 1000 + start[1] / 1e6),
  );
}

// parentSpanId: OTel SDK 2.x expoe parentSpanContext.spanId; SDKs mais antigos
// expoem parentSpanId cru. Aceita os dois.
function getParentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId?: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId ?? undefined;
}

// name curto do db_query: verbo + tabela/comando principal. O SQL/comando
// completo (so a FORMA, sem valores) mora em metadata.statement.
export function summarizeSql(statement: string, dbSystem: string): string {
  const s = statement.trim().replace(/\s+/g, " ");
  // Prisma via client extension: statement ja e "model.operation" — usa direto.
  if (dbSystem === "prisma") {
    return s;
  }
  if (dbSystem === "redis") {
    const cmd = s.split(/\s+/)[0]?.toUpperCase() || "CMD";
    return `redis ${cmd}`;
  }
  const upper = s.toUpperCase();
  const verb = upper.split(/\s+/)[0] || "SQL";
  const tableMatch =
    /\bFROM\s+"?([A-Za-z0-9_.]+)"?/.exec(upper) ||
    /\bINTO\s+"?([A-Za-z0-9_.]+)"?/.exec(upper) ||
    /\bUPDATE\s+"?([A-Za-z0-9_.]+)"?/.exec(upper);
  const table = tableMatch?.[1]?.toLowerCase();
  return table ? `${verb} ${table}` : verb;
}

function exceptionOf(span: ReadableSpan) {
  const exc = span.events?.find((e) => e.name === "exception");
  return {
    errored: Boolean(exc),
    errorMessage: exc?.attributes?.["exception.message"] as string | undefined,
    errorStack: exc?.attributes?.["exception.stacktrace"] as string | undefined,
  };
}

// ── classificacao span → payload ────────────────────────────────────────────────
// Retorna null pra descartar (span interno do ORM sem statement, span-raiz de job
// do worker, CLIENT do POST de saida, etc).
export function spanToPayload(
  span: ReadableSpan,
  source: string,
): GodeyePayload | null {
  const a = span.attributes;

  // Span-raiz que o worker abre em volta de cada job (so pras queries herdarem o
  // trace). O evento type:"job" e emitido a mao pelo job-wrapper — descartar aqui
  // evita double-emit.
  if (a["godeye.kind"] === "job-root") {
    return null;
  }

  const sc = span.spanContext();

  // db_query — REGRA DURA: so emite quando o span carrega db.statement. NAO
  // classificar por db.system / SpanKind / scope sozinho: o Prisma emite varios
  // spans por query e so o db_query tem statement. Deixar os internos passarem
  // viraria evento sem SQL e inflaria o volume ~5x.
  const statement = (a["db.statement"] ?? a["db.query.text"]) as
    | string
    | undefined;
  if (span.kind !== SpanKind.SERVER && statement) {
    const dbSystem =
      ((a["db.system"] ?? a["db.system.name"]) as string | undefined) ?? "db";
    const exc = exceptionOf(span);
    return {
      source,
      type: "db_query",
      name: summarizeSql(statement, dbSystem),
      status: exc.errored ? "error" : "ok",
      durationMs: hrToMs(span.startTime, span.endTime),
      traceId: sc.traceId,
      spanId: sc.spanId,
      parentSpanId: getParentSpanId(span),
      metadata: { dbSystem, statement },
      errorMessage: exc.errorMessage,
      errorStack: exc.errorStack,
    };
  }

  // http — SERVER span com metodo
  if (span.kind === SpanKind.SERVER) {
    const method = (a["http.request.method"] ?? a["http.method"]) as
      | string
      | undefined;
    if (!method) {
      return null;
    }

    const path = (a["http.route"] ??
      a["url.path"] ??
      a["http.target"] ??
      "/") as string;
    const statusRaw = a["http.response.status_code"] ?? a["http.status_code"];
    const httpStatus =
      typeof statusRaw === "number" ? statusRaw : Number(statusRaw) || 0;

    // consome o enrich do request (clientIp/userAgent do requestHook + userId do
    // setGodeyeUser). delete: o request acabou.
    const enrich = enrichByTrace.get(sc.traceId);
    enrichByTrace.delete(sc.traceId);
    const userAgent =
      ((a["user_agent.original"] ?? a["http.user_agent"]) as
        | string
        | undefined) ?? enrich?.userAgent;
    const clientIp =
      ((a["client.address"] ?? a["http.client_ip"] ?? a["net.peer.ip"]) as
        | string
        | undefined) ?? enrich?.clientIp;

    const exc = exceptionOf(span);
    return {
      source,
      type: "http",
      name: `${method} ${path}`,
      status: httpStatus >= 500 ? "error" : "ok",
      durationMs: hrToMs(span.startTime, span.endTime),
      method,
      path,
      httpStatus,
      requestId: sc.traceId,
      // colunas de trace: amarram os db_query filhos a este request no waterfall.
      traceId: sc.traceId,
      spanId: sc.spanId,
      parentSpanId: getParentSpanId(span),
      userAgent,
      clientIp,
      userId: enrich?.userId,
      errorMessage: exc.errorMessage,
      errorStack: exc.errorStack,
    };
  }

  return null;
}

// ── transporte em lote ───────────────────────────────────────────────────────
// SpanExporter custom envolvido pelo BatchSpanProcessor nativo (buffer/timer/
// flush/teto de memoria) — sem setInterval na mao, sem fila (telemetria e
// descartavel). Parametrizado por `source` (web e worker rotulam diferente).
function createGodeyeSpanExporter(source: string): SpanExporter {
  return {
    export(
      spans: ReadableSpan[],
      resultCallback: (result: ExportResult) => void,
    ): void {
      let payloads: GodeyePayload[];
      try {
        payloads = spans
          .map((span) => spanToPayload(span, source))
          .filter((p): p is GodeyePayload => p !== null);
      } catch (error) {
        resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
        return;
      }
      if (payloads.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      sendGodeyeBatch(payloads)
        .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
        .catch((error) =>
          resultCallback({ code: ExportResultCode.FAILED, error }),
        );
    },
    async shutdown(): Promise<void> {},
    async forceFlush(): Promise<void> {},
  };
}

export function createGodeyeBatchProcessor(
  source: string = getSource(),
): SpanProcessor {
  return new BatchSpanProcessor(createGodeyeSpanExporter(source), {
    maxExportBatchSize: 512, // manda quando junta ~512 spans...
    scheduledDelayMillis: 1000, // ...ou a cada ~1s, o que vier primeiro
    maxQueueSize: 2048, // teto de memoria; excedeu → dropa (nunca trava a app)
  });
}
