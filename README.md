# Animaca Geek Facebook Agent v0.3 — Netlify Free

Versão serverless do agente de postagem da Animaca Geek, adaptada para rodar no Netlify sem servidor contínuo.

## Arquitetura

- **Frontend:** arquivos estáticos em `public/`
- **API:** Netlify Functions em `netlify/functions/`
- **Dados:** Netlify Blobs (`animaca-products`, `animaca-posts`, `animaca-system`)
- **Imagens:** Netlify Blobs (`animaca-media`)
- **Agendamento:** Scheduled Function a cada 15 minutos
- **IA:** OpenAI API opcional para Planner/legendas
- **Publicação:** Meta Graph API

Não usa SQLite, Express, n8n, Railway nem servidor 24h.

## Variáveis no Netlify

Configure em **Project configuration → Environment variables**:

```env
APP_PASSWORD=uma-senha-forte
SESSION_SECRET=um-segredo-longo-e-aleatorio
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6
META_PAGE_ID=...
META_PAGE_ACCESS_TOKEN=...
META_USER_ACCESS_TOKEN=... # opcional; usado somente para validar tasks
META_GRAPH_VERSION=v25.0
AUTO_PUBLISH=false
TIMEZONE=America/Sao_Paulo
PLANNER_SLOTS=10:00,15:00,20:00
```

Durante homologação mantenha `AUTO_PUBLISH=false`.

## Deploy no Netlify

1. **Add new project → Import an existing project**.
2. Escolha GitHub e o repositório `Felipefelk/testeeee`.
3. O `netlify.toml` já informa a pasta pública e a pasta de Functions.
4. Adicione as variáveis acima.
5. Faça o deploy.
6. Entre no painel pela URL do Netlify.
7. Cadastre um produto e valide a persistência após um novo deploy.
8. Configure Meta e faça **uma postagem manual de teste**.
9. Só depois ative `AUTO_PUBLISH=true`.

## Segurança e anti-duplicação

Posts ficam em blobs individuais e a transição de publicação usa ETag/`onlyIfMatch`, de forma que duas Functions concorrentes não devem assumir o mesmo post. Uma falha de rede de resultado incerto muda o post para `needs_review`, impedindo retry automático cego.

## Agendamento

Netlify executa Scheduled Functions em UTC. O scheduler roda a cada 15 minutos e os posts são armazenados como timestamps UTC. O painel converte de/para `America/Sao_Paulo`.

## Observação de custo

A hospedagem pode operar no plano Free dentro dos créditos mensais do Netlify. A OpenAI API e eventuais custos/limites da Meta são serviços separados do Netlify.
