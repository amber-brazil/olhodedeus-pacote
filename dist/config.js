// Config de runtime + transporte fire-and-forget do Olho de Deus.
// Modulo LEVE de proposito: NAO importa nenhum pacote OTel, entao pode ser
// importado de qualquer lugar (route handler, edge, worker) sem arrastar o SDK.
const DEFAULT_INGEST_URL = "https://eye.grupoamber.com.br/api/v1/ingest";
const config = {
    source: "unknown",
    ingestUrl: process.env.GODEYE_INGEST_URL || DEFAULT_INGEST_URL,
    captureUser: process.env.GODEYE_CAPTURE_USER !== "false",
    timeoutMs: 500,
};
/** Aplicado por registerGodeye/registerGodeyeWorker no boot. */
export function configureGodeye(patch) {
    if (patch.source !== undefined)
        config.source = patch.source;
    if (patch.ingestUrl)
        config.ingestUrl = patch.ingestUrl;
    if (patch.captureUser !== undefined)
        config.captureUser = patch.captureUser;
    if (patch.timeoutMs !== undefined)
        config.timeoutMs = patch.timeoutMs;
}
export function getSource() {
    return config.source;
}
export function getIngestUrl() {
    return config.ingestUrl;
}
/** Hostname do endpoint de ingest — usado pra filtrar a auto-telemetria (não
 *  emitir http_out da chamada que o pacote faz pro próprio Olho de Deus). */
export function getIngestHost() {
    try {
        return new URL(config.ingestUrl).hostname.toLowerCase();
    }
    catch {
        return "";
    }
}
export function captureUserEnabled() {
    return config.captureUser;
}
// ── transporte ────────────────────────────────────────────────────────────────
// Token lido em RUNTIME (nunca no import) — sem GODEYE_TOKEN, no-op silencioso.
// Nunca lanca, timeout duro. O endpoint aceita array (lote) ou objeto unico.
export async function sendGodeyeBatch(payloads) {
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
    }
    finally {
        clearTimeout(timer);
    }
}
/** Evento unico fire-and-forget (job, startup ping, redis-error). Nao espera. */
export function sendGodeyeEvent(event) {
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
        .catch(() => { })
        .finally(() => clearTimeout(timer));
}
