# Animaca Geek Facebook Agent v0.2

Agente próprio para planejar, revisar, agendar e publicar conteúdo em uma Página do Facebook via Meta Graph API, sem n8n.

## O que mudou na v0.2

1. **Idempotência e bloqueio de publicação** — estados `approved → publishing → published`; chamadas concorrentes não assumem o mesmo post. Falha de rede com resultado incerto vira `needs_review` para evitar retry cego e postagem duplicada.
2. **SQLite** — o JSON deixou de ser o banco principal. SQLite usa WAL, transações e `PRAGMA integrity_check`.
3. **Proteção contra perda silenciosa** — se existir `data/db.json` legado e ele estiver corrompido, o servidor para e preserva o arquivo. Se estiver válido, importa uma vez para SQLite e cria backup `.bak`.
4. **Validação real da Meta** — o painel consulta a Graph API e verifica se o Page Access Token responde pela mesma Página configurada. `META_USER_ACCESS_TOKEN` é opcional para conferir `tasks` como `CREATE_CONTENT` sem publicar.
5. **Autenticação e uploads reforçados** — login gera cookie HttpOnly; senha não viaja em URL/header a cada requisição; limite de tentativas; imagens são verificadas pelo conteúdo real, reprocessadas para WEBP e servidas por rota autenticada.
6. **Timezone/agendamento** — o painel recebe horário local de `America/Sao_Paulo`, converte para UTC antes de salvar e reconverte para exibição.
7. **Calendário visual** — posts agendados aparecem agrupados por dia e horário.
8. **Planner** — escolhe produtos priorizando os menos/recentemente divulgados, cria três tipos de conteúdo e agenda os slots configurados como rascunhos para aprovação.

## Requisitos

- Node.js 20+
- Uma Página do Facebook gerenciada por você
- App Meta configurado com permissões adequadas à publicação em Página
- Page Access Token
- Chave da OpenAI para geração automática de legendas/Planner

## Instalação

```bash
npm install
cp .env.example .env
```

Edite `.env` e depois:

```bash
npm start
```

Abra `http://localhost:3000`.

## Configuração principal

```env
APP_PASSWORD=senha-forte
SESSION_SECRET=segredo-longo-e-aleatorio
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6
META_PAGE_ID=...
META_PAGE_ACCESS_TOKEN=...
META_USER_ACCESS_TOKEN=... # opcional, somente para validar tasks
META_GRAPH_VERSION=v25.0
AUTO_PUBLISH=false
TIMEZONE=America/Sao_Paulo
PLANNER_SLOTS=10:00,15:00,20:00
```

### Segurança

- Não coloque `.env` no Git.
- Em produção use HTTPS e `NODE_ENV=production`; o cookie de sessão passa a exigir `Secure`.
- Mantenha `AUTO_PUBLISH=false` durante a homologação.
- Não publique novamente um post em `needs_review` sem conferir primeiro a Página do Facebook.

## Fluxo recomendado

1. Cadastre produtos e imagens.
2. Clique em **Criar plano do dia**.
3. Revise texto, imagem e horário no calendário.
4. Aprove cada post.
5. Teste uma publicação manual real.
6. Depois de validar o fluxo, ative `AUTO_PUBLISH=true`.

## Estados de postagem

- `draft`: rascunho editável.
- `approved`: pronto para publicação.
- `publishing`: bloqueado enquanto a Meta é chamada.
- `published`: publicado com sucesso.
- `error`: a Meta rejeitou claramente a chamada; pode ser revisado e aprovado novamente.
- `needs_review`: houve falha de rede/resultado ambíguo; conferir a Página antes de qualquer nova tentativa.
- `cancelled`: cancelado.

## Migração do MVP anterior

Se `data/db.json` existir:

- JSON válido: importa produtos/posts para SQLite uma única vez e cria um backup do JSON.
- JSON inválido: **não cria banco vazio nem sobrescreve o arquivo**; o servidor encerra com erro explícito.

O banco atual fica em `data/animaca.sqlite`.
