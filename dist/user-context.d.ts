export interface TraceEnrichment {
    clientIp?: string;
    userAgent?: string;
    userId?: string;
}
export declare const enrichByTrace: Map<string, TraceEnrichment>;
export declare function setTraceEnrichment(traceId: string, patch: Partial<TraceEnrichment>): void;
/**
 * Carimba QUEM fez o request atual. Recebe o id canonico do user (o PK no banco
 * do projeto) — so o id, nunca nome/email (menos PII; o nome resolve depois via
 * MCP cruzando o id). Chamar no resolver central (session() do NextAuth OU no
 * resolver do webhook por identificador). Opt-out por env GODEYE_CAPTURE_USER=false.
 */
export declare function setGodeyeUser(userId: string | number | null | undefined): void;
