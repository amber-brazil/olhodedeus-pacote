# Atualizar o pacote num projeto consumidor

Runbook pra subir um repo que já usa `@amber/olho-de-deus` de uma versão pra
outra. Vale pros ~7 repos que mandam telemetria hoje (dashboard-bi, mística,
easyfit, anamnese-pmf, lp-pmf, PPI, remis).

**Antes de atualizar, leia a entrada da versão no [CHANGELOG](../CHANGELOG.md).**
Se ela disser _"Ação do consumidor: nenhuma"_, é só o procedimento abaixo — nada
de código do app muda.

---

## O prompt curto (o que dá pra decorar)

> Atualiza o `@amber/olho-de-deus` pra **vX.Y.Z** seguindo o runbook em
> `github.com/amber-brazil/olhodedeus-pacote/blob/main/docs/atualizar-consumidor.md`

Só isso. O agente lê este arquivo e encontra o resto. Use a versão longa abaixo
quando quiser ser explícito (ou quando o chat não tiver acesso à web).

## O prompt completo (cole no chat do projeto)

> Atualize o pacote `@amber/olho-de-deus` para a versão **vX.Y.Z**.
>
> 1. No `package.json`, troque a tag da dependência para
>    `github:amber-brazil/olhodedeus-pacote#vX.Y.Z`.
> 2. Rode o install do gerenciador que este repo usa (`pnpm install` ou
>    `npm install`) para **atualizar o lockfile**. Isso é obrigatório.
> 3. Rode o build/typecheck do projeto para confirmar que nada quebrou.
> 4. Commite `package.json` **e** o lockfile juntos.
>
> Não altere nenhum outro código do app — essa versão não muda a API do pacote.

---

## Por que o passo 2 é obrigatório

O lockfile **pina o SHA do commit**, não a tag. Se você editar só o
`package.json` e commitar, o CI roda `npm ci` / `pnpm install --frozen-lockfile`,
lê o lock antigo e **instala a versão velha assim mesmo** — ou falha por lock
dessincronizado.

É o modo de falha silencioso clássico: **deploy verde, pacote antigo**. Se depois
de deployar o comportamento novo não aparecer, o lockfile é o primeiro lugar pra
olhar (`grep olhodedeus-pacote` no lock e conferir o SHA).

Não é preciso buildar o pacote: o `dist/` é **commitado** no repo dele, então a
instalação por git já serve o JS compilado.

## Armadilhas conhecidas

- **npm** corrompe a subárvore `@emnapi` do `sharp` em install incremental. Se o
  install der erro estranho de módulo nativo, regenere o lock inteiro:
  `rm package-lock.json && npm install`. Isso pode bumpar type-deps — se
  `@types/*` quebrar um cast, pine a versão anterior.
- **pnpm** é estrito com peers. Repo que declara `@vercel/otel` ou
  `@opentelemetry/*` por conta própria dá conflito: **remova os OTel diretos
  redundantes** e deixe o pacote prover o set (ele já traz a safra v2 coerente).
- **Build local no Windows** pode falhar por Turbopack + symlink (`os error 1314`).
  Use `--webpack` ou confie na CI Linux.

## Verificar que subiu de verdade

Rodar não prova nada — o pacote é fire-and-forget e falha calada por design.
Confirme pelo **comportamento observável**, no banco do Olho de Deus:

```sql
-- Traces completos (http + db_query no mesmo trace) na última hora.
SELECT count(*) FILTER (WHERE http_n > 0 AND db_n > 0) AS completos,
       count(*) FILTER (WHERE http_n = 0 AND db_n > 0) AS orfaos
FROM (SELECT trace_id,
             count(*) FILTER (WHERE type = 'http')     AS http_n,
             count(*) FILTER (WHERE type = 'db_query') AS db_n
      FROM ingest_event
      WHERE source = '<source-do-projeto>'
        AND received_at >= now() - interval '1 hour'
      GROUP BY trace_id) t;
```

Aceite: `completos > 0` e `orfaos` perto de zero. Cuidado com falso positivo —
`db_query` e asset estático continuam chegando mesmo com a entrada HTTP quebrada,
então **"tem log chegando" não é critério**. Olhe trace completo e path de rota
real (`/login`, `/api/...`), não só `/_next/static/*`.

Pra quem for pra **v0.5.0**, confirme também que nenhum path novo tem segredo
legível:

```sql
SELECT source, count(*)
FROM ingest_event
WHERE received_at >= now() - interval '1 hour'
  AND path ~* '[?&](token|secret|key|apikey|api_key|password|senha|auth|signature|sig|access_token|refresh_token)=[^&*]'
GROUP BY source;
```

Aceite: zero linhas.
