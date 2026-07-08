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
export declare function instrumentPostgresClient(client: unknown): void;
