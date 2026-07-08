// Emissor de evento de erro de Redis. Fire-and-forget, throttle contra rajada de
// reconnect. Ligar num redis.on("error", reportRedisError) — sem isso o erro de
// socket nao deixa rastro nenhum (fica preso na offline queue sem log).
import { getSource, sendGodeyeEvent } from "./config.js";
const DEFAULT_THROTTLE_MS = 30_000;
const EVENT_NAME = "redis.connection.error";
export function createRedisErrorReporter(options = {}) {
    const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    const now = options.now ?? Date.now;
    let lastEmittedAt = 0;
    return function reportRedisError(errorMessage) {
        const current = now();
        if (lastEmittedAt !== 0 && current - lastEmittedAt < throttleMs) {
            return;
        }
        lastEmittedAt = current;
        sendGodeyeEvent({
            source: getSource(),
            type: "event",
            status: "error",
            name: EVENT_NAME,
            errorMessage,
        });
    };
}
export const reportRedisError = createRedisErrorReporter();
