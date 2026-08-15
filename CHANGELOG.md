# Changelog

## v0.3.0

- Arquitetura convertida de servidor Node contínuo para Netlify serverless.
- SQLite substituído por registros individuais no Netlify Blobs.
- Uploads movidos para Netlify Blobs e persistem entre deploys.
- Concorrência/idempotência preservadas com ETag + `onlyIfMatch`.
- Express, multer, better-sqlite3 e node-cron removidos.
- Scheduled Function criada para verificar posts aprovados a cada 15 minutos.
- Sessão continua stateless e HttpOnly/Secure.
- Rate limit de login persistido em Blobs.
- Planner, calendário, validação da Meta e geração via OpenAI preservados.
