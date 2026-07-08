# @amber/olho-de-deus

Instrumentação **OpenTelemetry** do [Olho de Deus](https://eye.grupoamber.com.br) — a
observabilidade interna da Amber. Um pacote, uma chamada: liga **HTTP + db_query + Redis
+ jobs + userId**, todos amarrados por `traceId`, e manda em lote pro ingest.

Substitui o `lib/godeye/*` bespoke que cada repo escrevia à mão (e errava). O fix de um
bug vive **aqui**, não em 5 repos.

> Uso interno. Instalado **via git** (não publicado no npm registry).

## Instalar

```bash
pnpm add github:amber-brazil/olhodedeus-pacote#v0.1.0
```

O `@opentelemetry/api` é peer dep — projetos Next normalmente já têm. Se faltar:
`pnpm add @opentelemetry/api`.

## Env

| Var | Obrigatória | Descrição |
|---|---|---|
| `GODEYE_TOKEN` | sim | Token per-project do dashboard. Sem ele, tudo vira no-op silencioso. |
| `GODEYE_INGEST_URL` | não | Override do endpoint (default: produção). Útil pra staging. |
| `GODEYE_CAPTURE_USER` | não | `false` desliga a captura de userId sem tocar código. |

## Uso

### Web (Next.js) — `instrumentation.ts` na raiz

```ts
import { registerGodeye } from "@amber/olho-de-deus/web";

export function register() {
  return registerGodeye({ source: "meu-projeto-web" });
}
```

### DB — Prisma (client extension)

```ts
import { PrismaClient } from "@prisma/client";
import { godeyePrismaExtension } from "@amber/olho-de-deus";

export const prisma = new PrismaClient().$extends(godeyePrismaExtension);
```

### DB — Drizzle + postgres.js

```ts
import postgres from "postgres";
import { instrumentPostgresClient } from "@amber/olho-de-deus";

const client = postgres(process.env.POSTGRES_URL!);
instrumentPostgresClient(client); // 1 linha, antes de passar pro drizzle()
```

### userId — no resolver central (o ponto onde você sabe quem é o user)

```ts
import { setGodeyeUser } from "@amber/olho-de-deus";

// NextAuth: no callback session()
setGodeyeUser(session.user.id);

// Webhook por identificador: logo após resolver o user no banco
const user = await prisma.user.findUnique({ where: { whatsapp } });
setGodeyeUser(user?.id); // só o id — nunca nome/email
```

### Worker (BullMQ via tsx) / Nest — primeira linha do entrypoint

```ts
import { registerGodeyeWorker } from "@amber/olho-de-deus/worker";
await registerGodeyeWorker({ source: "meu-projeto-worker" });

import { godeyeJobWrapper } from "@amber/olho-de-deus";
new Worker(queue, godeyeJobWrapper(async (job) => { /* ... */ }), { connection });
```

### Redis — reportar erro de conexão

```ts
import { reportRedisError } from "@amber/olho-de-deus";
redis.on("error", (e) => reportRedisError(e.message));
```

## Princípios

- **Fire-and-forget:** nunca bloqueia o request. Timeout duro de 500ms. Nunca lança.
- **Sem token → no-op.** Adicionar o pacote não muda nada até `GODEYE_TOKEN` existir — é
  aditivo e não gera regressão.
- **PII:** só a **forma** do SQL (`WHERE id = $1`, `user.findUnique`), nunca os valores.
  userId é só o **id** canônico, nunca nome/email.
- **DB via Prisma extension**, não `@prisma/instrumentation` (que quebra sob OTel SDK 2.x).

## Status

`v0.1` — paridade com a instrumentação comprovada da anamnese-pmf (Next + worker + Prisma).
`userId` usa o map por `traceId`; o endurecimento por OTel baggage é a v0.2.
Suporte a Nest com `instrumentation-http` no path worker: v0.2.
