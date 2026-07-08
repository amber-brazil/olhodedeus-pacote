// Entry WORKER / Nest — processo Node fora do Next (BullMQ worker via tsx, ou
// um app Nest). Registra um NodeTracerProvider proprio (nao usa @vercel/otel).
//
// IMPORTANTE: importar/chamar como a PRIMEIRA coisa do entrypoint do worker,
// antes de prisma/bullmq/ioredis carregarem.
//
//   import { registerGodeyeWorker } from "@amber/olho-de-deus/worker";
//   await registerGodeyeWorker({ source: "meu-projeto-worker" });
//
// Escopo: spans de QUERY (Prisma via extension / postgres.js via wrapper) + jobs
// (godeyeJobWrapper) + chamadas de SAIDA (http_out) via fetch (undici) e node:http
// (axios). O register() liga o AsyncHooksContextManager, que faz o span-raiz do
// job ficar ATIVO pras queries e chamadas de saida herdarem o trace.
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

import { configureGodeye, sendGodeyeEvent, type GodeyeOptions } from "./config.js";
import { createGodeyeBatchProcessor } from "./span-processor.js";

export async function registerGodeyeWorker(
  options: GodeyeOptions,
): Promise<{ forceFlush: () => Promise<void> }> {
  configureGodeye(options);

  const provider = new NodeTracerProvider({
    spanProcessors: [createGodeyeBatchProcessor(options.source)],
  });
  provider.register();

  // Instrumenta as chamadas de SAIDA do worker → viram http_out (o "caminho
  // completo" do trabalho pesado: OpenAI, Bunny, Meta, etc). fetch (Node global =
  // undici) cobre os SDKs modernos; node:http cobre axios/http client. O filtro
  // de auto-telemetria no spanToPayload descarta o POST pro proprio ingest. Sem
  // requestHook: no worker nao ha SERVER (so CLIENT de saida).
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });
  console.log("[godeye] worker OTel registered, source=", options.source);

  // Flush final no SIGTERM/SIGINT (Railway) pra nao perder o ultimo lote.
  const forceFlush = async (): Promise<void> => {
    try {
      await provider.forceFlush();
    } catch {
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
