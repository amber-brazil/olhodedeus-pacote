// Entry WEB — Next.js via @vercel/otel. Chamar dentro do register() do
// instrumentation.ts na raiz do projeto Next.
//
//   import { registerGodeye } from "@amber/olho-de-deus/web";
//   export function register() {
//     return registerGodeye({ source: "meu-projeto-web" });
//   }
import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "@opentelemetry/instrumentation";

import { configureGodeye, sendGodeyeEvent, type GodeyeOptions } from "./config.js";
import { createGodeyeBatchProcessor, godeyeRequestHook } from "./span-processor.js";

export async function registerGodeye(options: GodeyeOptions): Promise<void> {
  configureGodeye(options);
  console.log(
    "[godeye] registerGodeye() source=",
    options.source,
    "runtime=",
    process.env.NEXT_RUNTIME,
  );
  try {
    const instrumentations: Instrumentation[] = [];
    // instrumentation-http e Node-only (async_hooks + monkey-patch de node:http).
    // Edge runtime quebra o import — gate por NEXT_RUNTIME. O requestHook captura
    // clientIp/userAgent do IncomingMessage cru. DB vem da client extension do
    // Prisma / do wrapper de postgres.js (nao daqui).
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { HttpInstrumentation } = await import(
        "@opentelemetry/instrumentation-http"
      );
      instrumentations.push(
        new HttpInstrumentation({ requestHook: godeyeRequestHook }),
      );
    }

    registerOTel({
      serviceName: options.source,
      spanProcessors: [createGodeyeBatchProcessor(options.source)],
      instrumentations,
    });
    console.log("[godeye] registerOTel done");
  } catch (e) {
    console.error("[godeye] registerGodeye failed:", e);
  }

  // Startup ping: ao subir, o Olho de Deus recebe um "godeye-startup" e confirma
  // "instrumentacao viva" sem precisar bater rota. Fire-and-forget.
  if (process.env.GODEYE_TOKEN) {
    sendGodeyeEvent({
      source: options.source,
      type: "event",
      name: "godeye-startup",
      status: "ok",
      metadata: { runtime: process.env.NEXT_RUNTIME ?? "nodejs" },
    });
  }
}
