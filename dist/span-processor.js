import { SpanKind } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { BatchSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { getSource, sendGodeyeBatch } from "./config.js";
import { enrichByTrace, setTraceEnrichment } from "./user-context.js";
// ── requestHook do HttpInstrumentation ────────────────────────────────────────
// Captura clientIp/userAgent do IncomingMessage cru (o SERVER span do Next nao
// expoe headers) e guarda por traceId pro exporter consumir no export().
export function godeyeRequestHook(span, request) {
    const kind = span.kind;
    if (kind !== SpanKind.SERVER) {
        return;
    }
    if (!("headers" in request) || !("socket" in request)) {
        return;
    }
    const h = request.headers;
    const xff = h["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    const clientIp = xffStr?.split(",")[0]?.trim() ||
        h["x-real-ip"] ||
        h["cf-connecting-ip"] ||
        h["fly-client-ip"] ||
        request.socket?.remoteAddress ||
        undefined;
    const userAgent = h["user-agent"];
    setTraceEnrichment(span.spanContext().traceId, { clientIp, userAgent });
}
// ── helpers puros ──────────────────────────────────────────────────────────────
function hrToMs(start, end) {
    return Math.round(end[0] * 1000 + end[1] / 1e6 - (start[0] * 1000 + start[1] / 1e6));
}
// parentSpanId: OTel SDK 2.x expoe parentSpanContext.spanId; SDKs mais antigos
// expoem parentSpanId cru. Aceita os dois.
function getParentSpanId(span) {
    const s = span;
    return s.parentSpanContext?.spanId ?? s.parentSpanId ?? undefined;
}
// name curto do db_query: verbo + tabela/comando principal. O SQL/comando
// completo (so a FORMA, sem valores) mora em metadata.statement.
export function summarizeSql(statement, dbSystem) {
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
    const tableMatch = /\bFROM\s+"?([A-Za-z0-9_.]+)"?/.exec(upper) ||
        /\bINTO\s+"?([A-Za-z0-9_.]+)"?/.exec(upper) ||
        /\bUPDATE\s+"?([A-Za-z0-9_.]+)"?/.exec(upper);
    const table = tableMatch?.[1]?.toLowerCase();
    return table ? `${verb} ${table}` : verb;
}
function exceptionOf(span) {
    const exc = span.events?.find((e) => e.name === "exception");
    return {
        errored: Boolean(exc),
        errorMessage: exc?.attributes?.["exception.message"],
        errorStack: exc?.attributes?.["exception.stacktrace"],
    };
}
// ── classificacao span → payload ────────────────────────────────────────────────
// Retorna null pra descartar (span interno do ORM sem statement, span-raiz de job
// do worker, CLIENT do POST de saida, etc).
export function spanToPayload(span, source) {
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
    const statement = (a["db.statement"] ?? a["db.query.text"]);
    if (span.kind !== SpanKind.SERVER && statement) {
        const dbSystem = (a["db.system"] ?? a["db.system.name"]) ?? "db";
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
        const method = (a["http.request.method"] ?? a["http.method"]);
        if (!method) {
            return null;
        }
        const path = (a["http.route"] ??
            a["url.path"] ??
            a["http.target"] ??
            "/");
        const statusRaw = a["http.response.status_code"] ?? a["http.status_code"];
        const httpStatus = typeof statusRaw === "number" ? statusRaw : Number(statusRaw) || 0;
        // consome o enrich do request (clientIp/userAgent do requestHook + userId do
        // setGodeyeUser). delete: o request acabou.
        const enrich = enrichByTrace.get(sc.traceId);
        enrichByTrace.delete(sc.traceId);
        const userAgent = (a["user_agent.original"] ?? a["http.user_agent"]) ?? enrich?.userAgent;
        const clientIp = (a["client.address"] ?? a["http.client_ip"] ?? a["net.peer.ip"]) ?? enrich?.clientIp;
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
function createGodeyeSpanExporter(source) {
    return {
        export(spans, resultCallback) {
            let payloads;
            try {
                payloads = spans
                    .map((span) => spanToPayload(span, source))
                    .filter((p) => p !== null);
            }
            catch (error) {
                resultCallback({ code: ExportResultCode.FAILED, error: error });
                return;
            }
            if (payloads.length === 0) {
                resultCallback({ code: ExportResultCode.SUCCESS });
                return;
            }
            sendGodeyeBatch(payloads)
                .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
                .catch((error) => resultCallback({ code: ExportResultCode.FAILED, error }));
        },
        async shutdown() { },
        async forceFlush() { },
    };
}
export function createGodeyeBatchProcessor(source = getSource()) {
    return new BatchSpanProcessor(createGodeyeSpanExporter(source), {
        maxExportBatchSize: 512, // manda quando junta ~512 spans...
        scheduledDelayMillis: 1000, // ...ou a cada ~1s, o que vier primeiro
        maxQueueSize: 2048, // teto de memoria; excedeu → dropa (nunca trava a app)
    });
}
