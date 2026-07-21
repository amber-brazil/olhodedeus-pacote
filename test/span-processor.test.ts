import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { spanToPayload } from "../src/span-processor.js";

// Monta um ReadableSpan minimo — so os campos que o spanToPayload le.
function fakeSpan(over: {
  kind: SpanKind;
  attributes: Record<string, unknown>;
  traceId?: string;
}): ReadableSpan {
  return {
    kind: over.kind,
    attributes: over.attributes,
    startTime: [1000, 0],
    endTime: [1000, 5_000_000],
    events: [],
    spanContext: () => ({
      traceId: over.traceId ?? "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    }),
  } as unknown as ReadableSpan;
}

// ── status invalido no span de ENTRADA ────────────────────────────────────────
// O span nativo do Next 14 (instrumentationScope "next.js") e SERVER e tem
// http.method, mas NAO carrega http.response.status_code. Emitir httpStatus: 0
// reprova no `min(100)` do Zod do ingest e — como o POST manda o lote inteiro
// num array so — derruba TODOS os eventos do mesmo batch (400 no lote).
// Foi o que zerou a telemetria do anamnese-pmf de 08/07 a 20/07/2026.
test("SERVER sem status code e descartado (nao vira httpStatus 0)", () => {
  const span = fakeSpan({
    kind: SpanKind.SERVER,
    attributes: { "http.method": "GET", "http.route": "/login" },
  });

  assert.equal(spanToPayload(span, "anamnese-pmf-web"), null);
});

test("SERVER com status code vira payload http normalmente", () => {
  const span = fakeSpan({
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": "GET",
      "url.path": "/login",
      "http.response.status_code": 200,
    },
  });

  const payload = spanToPayload(span, "anamnese-pmf-web");

  assert.equal(payload?.type, "http");
  assert.equal(payload?.httpStatus, 200);
  assert.equal(payload?.name, "GET /login");
});

// ── segredo na query string ───────────────────────────────────────────────────
// Webhook autenticado por querystring gravava o segredo em texto claro no
// ingest_event (27.837 linhas na mistica, 410 no anamnese em 20/07/2026), e as
// chamadas de SAIDA gravavam access_token da Meta e API key do Gemini. Redigir
// o VALOR preservando a chave: mantem a rota util pra debug, sem o segredo.
test("redige o valor de parametro sensivel no path e no name (entrada)", () => {
  const span = fakeSpan({
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": "POST",
      "url.path": "/api/webhooks/funnel/fcl-bunday?secret=N-TsFE4zz7DWTjDNyUke",
      "http.response.status_code": 200,
    },
  });

  const payload = spanToPayload(span, "mistica-web");

  assert.equal(payload?.path, "/api/webhooks/funnel/fcl-bunday?secret=***");
  assert.equal(payload?.name, "POST /api/webhooks/funnel/fcl-bunday?secret=***");
});

test("redige o valor de parametro sensivel na chamada de saida (http_out)", () => {
  const span = fakeSpan({
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": "POST",
      "url.full":
        "https://graph.facebook.com/v21.0/1476544103739644/events?access_token=EAAG123secreto",
      "http.response.status_code": 200,
    },
  });

  const payload = spanToPayload(span, "lp-pmf-next");

  assert.equal(payload?.type, "http_out");
  assert.equal(payload?.path, "/v21.0/1476544103739644/events?access_token=***");
  assert.equal(
    payload?.name,
    "POST graph.facebook.com/v21.0/1476544103739644/events?access_token=***",
  );
});

test("preserva query string legitima (so o parametro sensivel e redigido)", () => {
  const span = fakeSpan({
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": "GET",
      "url.path": "/api/admin/experiences?q=99039442&page=2&token=abc123",
      "http.response.status_code": 200,
    },
  });

  const payload = spanToPayload(span, "easyfit-web");

  assert.equal(payload?.path, "/api/admin/experiences?q=99039442&page=2&token=***");
});

test("path sem query string passa intacto", () => {
  const span = fakeSpan({
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": "GET",
      "url.path": "/api/admin/experiences/cmrt9ynm402e8ox39x7lfl73d/agents",
      "http.response.status_code": 200,
    },
  });

  const payload = spanToPayload(span, "easyfit-web");

  assert.equal(
    payload?.path,
    "/api/admin/experiences/cmrt9ynm402e8ox39x7lfl73d/agents",
  );
});
