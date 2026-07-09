// Contexto de request por traceId (clientIp / userAgent / userId).
//
// Modulo LEVE: importa so @opentelemetry/api (sem o SDK de tracing), pra ser
// seguro importar em route handlers e no resolver de auth sem arrastar o
// sdk-trace-base pro bundle deles (e sem quebrar o edge runtime).
//
// v0.1: mecanismo do map ancorado no globalThis — o mesmo que produziu userId
// real na anamnese. O endurecimento por OTel baggage (pra cobrir os runtimes
// onde o traceId do handler != traceId do span SERVER) e a v0.2.
import { trace } from "@opentelemetry/api";
import { captureUserEnabled } from "./config.js";

export interface TraceEnrichment {
  clientIp?: string;
  userAgent?: string;
  userId?: string;
  // Geo da Cloudflare (headers cf-ipcountry/cf-region/cf-ipcity), quando o app
  // roda atras da CF. O ingest do Olho de Deus prefere esse geo sobre o
  // geoip-lite (mais preciso — vem do IP real do visitante). Opcionais.
  geoCountry?: string;
  geoRegion?: string;
  geoCity?: string;
}

// Chave = traceId (estavel no request inteiro). Ancorado no globalThis (nao um
// `new Map()` de modulo) porque no Next o instrumentation.ts (exporter, que LE)
// e os route handlers/auth (setGodeyeUser, que ESCREVE) podem carregar
// instancias SEPARADAS deste modulo — dois maps distintos fariam o userId
// escrito no lado app nunca ser visto pelo exporter. O globalThis garante um
// unico map no processo.
const globalForGodeye = globalThis as unknown as {
  __godeyeEnrichByTrace?: Map<string, TraceEnrichment>;
};
export const enrichByTrace: Map<string, TraceEnrichment> =
  globalForGodeye.__godeyeEnrichByTrace ??
  (globalForGodeye.__godeyeEnrichByTrace = new Map<string, TraceEnrichment>());

// TTL de seguranca: se o span nunca fechar (request abortado), a entrada nao
// vaza pra sempre. O caminho normal e o exporter dar delete ao emitir o http.
const ENRICH_TTL_MS = 60_000;

export function setTraceEnrichment(
  traceId: string,
  patch: Partial<TraceEnrichment>,
): void {
  const existing = enrichByTrace.get(traceId);
  enrichByTrace.set(traceId, { ...existing, ...patch });
  setTimeout(() => enrichByTrace.delete(traceId), ENRICH_TTL_MS).unref?.();
}

/**
 * Carimba QUEM fez o request atual. Recebe o id canonico do user (o PK no banco
 * do projeto) — so o id, nunca nome/email (menos PII; o nome resolve depois via
 * MCP cruzando o id). Chamar no resolver central (session() do NextAuth OU no
 * resolver do webhook por identificador). Opt-out por env GODEYE_CAPTURE_USER=false.
 */
export function setGodeyeUser(
  userId: string | number | null | undefined,
): void {
  if (!captureUserEnabled() || userId == null) {
    return;
  }
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  if (!traceId) {
    return;
  }
  setTraceEnrichment(traceId, { userId: String(userId) });
}
