# Changelog

## v0.2.0

- Bloqueio transacional contra publicação duplicada e estado `needs_review` para resultados de rede ambíguos.
- Migração do armazenamento para SQLite com WAL e verificação de integridade.
- Migração segura do JSON legado, sem recriar/zerar banco em caso de corrupção.
- Validação real de Page Access Token/ID pela Meta Graph API; validação opcional de tasks com User Access Token.
- Login por sessão HttpOnly, limite de tentativas e remoção da senha de URL/header em chamadas normais.
- Uploads restritos a JPEG/PNG/WEBP, validação por assinatura real e reprocessamento para WEBP.
- Agendamento interpretado em America/Sao_Paulo e salvo em UTC.
- Calendário visual de posts agendados.
- Planner automático com rotação de produtos e três objetivos de conteúdo.
