// Entry WORKER / Nest — processo Node fora do Next (BullMQ worker via tsx, ou
// um app Nest). Registra um NodeTracerProvider proprio (nao usa @vercel/otel).
//
// IMPORTANTE: importar/chamar como a PRIMEIRA coisa do entrypoint do worker,
// antes de prisma/bullmq/ioredis carregarem.
//
//   import { registerGodeyeWorker } from "@amber/olho-de-deus/worker";
//   await registerGodeyeWorker({ source: "meu-projeto-worker" });
//
// Escopo v0.1: spans de QUERY (Prisma via extension / postgres.js via wrapper) +
// jobs (godeyeJobWrapper). O register() liga o AsyncHooksContextManager, que faz
// o span-raiz do job ficar ATIVO pras queries herdarem o trace.
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { configureGodeye, sendGodeyeEvent } from "./config.js";
import { createGodeyeBatchProcessor } from "./span-processor.js";
export async function registerGodeyeWorker(options) {
    configureGodeye(options);
    const provider = new NodeTracerProvider({
        spanProcessors: [createGodeyeBatchProcessor(options.source)],
    });
    provider.register();
    console.log("[godeye] worker OTel registered, source=", options.source);
    // Flush final no SIGTERM/SIGINT (Railway) pra nao perder o ultimo lote.
    const forceFlush = async () => {
        try {
            await provider.forceFlush();
        }
        catch {
            // telemetria e descartavel — nunca trava o shutdown
        }
    };
    process.on("SIGTERM", forceFlush);
    process.on("SIGINT", forceFlush);
    if (process.env.GODEYE_TOKEN) {
        sendGodeyeEvent({
            source: options.source,
            type: "event",
            name: "godeye-startup",
            status: "ok",
            metadata: { runtime: "worker" },
        });
    }
    return { forceFlush };
}
