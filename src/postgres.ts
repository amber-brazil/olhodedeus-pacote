import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const TRACER_NAME = "godeye-db";
// So envolve o client uma vez (HMR/imports multiplos poderiam re-envolver).
const WRAPPED = Symbol.for("godeye.postgres.wrapped");

type UnsafeFn = (
  query: string,
  params?: unknown[],
  options?: unknown,
) => PromiseLike<unknown>;

/**
 * Instrumenta o client postgres.js (porsager) pra emitir um span CLIENT por
 * query, amarrado ao request/job pai pelo contexto ativo (mesmo traceId → entra
 * no waterfall). So a FORMA do SQL entra em db.statement (placeholders $1,$2);
 * os VALORES dos parametros NUNCA (PII).
 *
 * Por que aqui e nao @opentelemetry/instrumentation-pg: quem usa
 * drizzle-orm/postgres-js + driver `postgres` NAO passa pelo pacote `pg` — a
 * instrumentacao oficial faz monkey-patch do `pg` e capturaria zero query. Nao
 * existe instrumentacao OTel oficial pra postgres.js.
 *
 * Como: todo query do Drizzle passa por client.unsafe(query, params). O Query do
 * postgres.js estende Promise, entao anexamos um observador .then() SEPARADO que
 * fecha o span no settle e devolvemos o MESMO pending pro Drizzle — sem proxy,
 * sem alterar o comportamento do query. Se a instrumentacao falhar, a query
 * segue intacta (fire-and-forget).
 */
export function instrumentPostgresClient(client: unknown): void {
  const c = client as {
    unsafe?: UnsafeFn;
    [k: symbol]: unknown;
  };
  if (!c || typeof c.unsafe !== "function") {
    return;
  }
  if (c[WRAPPED]) {
    return;
  }

  const origUnsafe = c.unsafe.bind(c) as UnsafeFn;
  // ProxyTracer do OTel: resolve o provider global vivo a cada startSpan, entao
  // cachear aqui (mesmo antes do register rodar) e seguro.
  const tracer = trace.getTracer(TRACER_NAME);

  c.unsafe = ((query: string, params?: unknown[], options?: unknown) => {
    const pending = origUnsafe(query, params, options);
    try {
      const span = tracer.startSpan(
        "db.query",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "db.system": "postgresql",
            // SO a forma (placeholders), nunca `params`.
            "db.statement": typeof query === "string" ? query : String(query),
          },
        },
        // context.active() = span do request/job atual → parent correto.
        context.active(),
      );

      // Sem provider (worker/edge sem register): span nao-gravado → encerra e sai.
      if (!span.isRecording()) {
        span.end();
        return pending;
      }

      if (typeof pending?.then === "function") {
        pending.then(
          () => span.end(),
          (err: unknown) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            if (err instanceof Error) {
              span.recordException(err);
            }
            span.end();
          },
        );
      } else {
        span.end();
      }
    } catch {
      // Instrumentacao nunca afeta a query.
    }
    return pending;
  }) as UnsafeFn;

  Object.defineProperty(c, WRAPPED, { value: true, enumerable: false });
}
