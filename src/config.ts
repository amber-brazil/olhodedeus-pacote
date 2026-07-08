// Config de runtime + transporte fire-and-forget do Olho de Deus.
// Modulo LEVE de proposito: NAO importa nenhum pacote OTel, entao pode ser
// importado de qualquer lugar (route handler, edge, worker) sem arrastar o SDK.

export type GodeyePayload = Record<string, unknown>;

export interface GodeyeOptions {
  /** Identifica o componente. Ex: "anamnese-pmf-web", "remis-worker". Hardcode por processo. */
  source: string;
  /** Override do endpoint de ingest. Default: env GODEYE_INGEST_URL ou o de producao. */
  ingestUrl?: string;
  /** Liga/desliga a captura de userId. Default: env GODEYE_CAPTURE_USER !== "false". */
  captureUser?: boolean;
  /** Timeout duro do POST de telemetria (ms). Default 500. */
  timeoutMs?: number;
}

const DEFAULT_INGEST_URL = "https://eye.grupoamber.com.br/api/v1/ingest";

interface ResolvedConfig {
  source: string;
  ingestUrl: string;
  captureUser: boolean;
  timeoutMs: number;
}

const config: ResolvedConfig = {
  source: "unknown",
  ingestUrl: process.env.GODEYE_INGEST_URL || DEFAULT_INGEST_URL,
  captureUser: process.env.GODEYE_CAPTURE_USER !== "false",
  timeoutMs: 500,
};

/** Aplicado por registerGodeye/registerGodeyeWorker no boot. */
export function configureGodeye(patch: Partial<GodeyeOptions>): void {
  if (patch.source !== undefined) config.source = patch.source;
  if (patch.ingestUrl) config.ingestUrl = patch.ingestUrl;
  if (patch.captureUser !== undefined) config.captureUser = patch.captureUser;
  if (patch.timeoutMs !== undefined) config.timeoutMs = patch.timeoutMs;
}

export function getSource(): string {
  return config.source;
}
export function getIngestUrl(): string {
  return config.ingestUrl;
}
export function captureUserEnabled(): boolean {
  return config.captureUser;
}

// ── transporte ────────────────────────────────────────────────────────────────
// Token lido em RUNTIME (nunca no import) — sem GODEYE_TOKEN, no-op silencioso.
// Nunca lanca, timeout duro. O endpoint aceita array (lote) ou objeto unico.

export async function sendGodeyeBatch(payloads: GodeyePayload[]): Promise<void> {
  const token = process.env.GODEYE_TOKEN;
  if (!token || payloads.length === 0) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    await fetch(config.ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-godeye-token": token,
      },
      body: JSON.stringify(payloads.length === 1 ? payloads[0] : payloads),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Evento unico fire-and-forget (job, startup ping, redis-error). Nao espera. */
export function sendGodeyeEvent(event: GodeyePayload): void {
  const token = process.env.GODEYE_TOKEN;
  if (!token) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  void fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-godeye-token": token,
    },
    body: JSON.stringify(event),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
