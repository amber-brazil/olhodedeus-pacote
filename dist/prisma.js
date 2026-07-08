import { SpanKind, trace } from "@opentelemetry/api";
// Spans de query do Prisma via CLIENT EXTENSION (nao via @prisma/instrumentation).
// Motivo: @prisma/instrumentation@5.x e da era OTel SDK 1.x e QUEBRA sob o
// provider 2.x que o @vercel/otel@2.x registra (foi o version-skew que zerou o
// db_query do PPI). A extension roda no contexto de trace do request/job, entao o
// span nasce filho do span pai (HTTP server / job-root) e cai no MESMO
// BatchSpanProcessor. NAO importa @prisma/client aqui (zero acoplamento de versao).
//
// Uso no app:
//   import { godeyePrismaExtension } from "@amber/olho-de-deus";
//   export const prisma = new PrismaClient().$extends(godeyePrismaExtension);
const tracer = trace.getTracer("godeye-prisma");
export const godeyePrismaExtension = {
    name: "godeye",
    query: {
        // $allOperations no topo cobre TODA operacao: models + raw ($queryRaw/etc).
        async $allOperations({ model, operation, args, query }) {
            // db.statement = "model.operation" (ex "user.findUnique"). NUNCA os args
            // (tem valores → PII). Sem args, e a FORMA da query.
            const statement = model ? `${model}.${operation}` : operation;
            return tracer.startActiveSpan(`prisma ${statement}`, {
                kind: SpanKind.CLIENT,
                attributes: {
                    "db.system": "prisma",
                    "db.statement": statement,
                },
            }, async (span) => {
                try {
                    return await query(args);
                }
                catch (err) {
                    span.recordException(err);
                    throw err;
                }
                finally {
                    span.end();
                }
            });
        },
    },
};
