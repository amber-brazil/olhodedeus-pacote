import { type Span } from "@opentelemetry/api";
import { type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { IncomingMessage, ClientRequest } from "node:http";
import { type GodeyePayload } from "./config.js";
export declare function godeyeRequestHook(span: Span, request: IncomingMessage | ClientRequest): void;
export declare function summarizeSql(statement: string, dbSystem: string): string;
/**
 * Redige o VALOR dos parametros sensiveis de uma query string, preservando a
 * chave e a estrutura (`?secret=***`). Preserva query legitima (`?q=123`) —
 * descartar a query inteira perderia contexto util de debug, e descartar o
 * evento perderia justamente o trafego de webhook, que e o que mais interessa.
 */
export declare function redactQuerySecrets(pathWithQuery: string): string;
export declare function spanToPayload(span: ReadableSpan, source: string): GodeyePayload | null;
export declare function createGodeyeBatchProcessor(source?: string): SpanProcessor;
