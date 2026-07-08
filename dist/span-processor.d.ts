import { type Span } from "@opentelemetry/api";
import { type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { IncomingMessage, ClientRequest } from "node:http";
import { type GodeyePayload } from "./config.js";
export declare function godeyeRequestHook(span: Span, request: IncomingMessage | ClientRequest): void;
export declare function summarizeSql(statement: string, dbSystem: string): string;
export declare function spanToPayload(span: ReadableSpan, source: string): GodeyePayload | null;
export declare function createGodeyeBatchProcessor(source?: string): SpanProcessor;
