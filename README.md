# Animaca Geek Facebook Agent v0.5

Agente serverless para Netlify com foco em eficiência, segurança e autonomia controlada.

## Estratégia diária

- **09:15/09:35 BRT**: prepara a venda das 10h (segunda execução funciona como retry controlado).
- **10:00 BRT**: publica a venda aprovada.
- **14:15/14:35 BRT**: pesquisa e prepara o hype das 15h.
- **15:00 BRT**: publica o hype aprovado.
- **19:15/19:35 BRT**: prepara o conteúdo de crescimento das 20h.
- **20:00 BRT**: publica o crescimento aprovado.
- **03:00 BRT**: coleta performance recente para o agente aprender.

Total normal: 10 Scheduled Function runs/dia, contra 96/dia na v0.4.

## Principais correções

- Idempotência por `data + tipo` via plano diário persistente.
- Conteúdo gerado just-in-time, não de madrugada.
- No máximo 2 tentativas de criação por slot.
- Budget diário de IA e intervalo mínimo de sincronização Shopee.
- Copy simples roteada para `gpt-5-mini`; web fica no modelo configurado para pesquisa.
- Link Shopee não é escrito pela IA: o servidor acrescenta a URL canônica no momento da publicação.
- Produtos descobertos pela busca da Shopee entram **inativos e não verificados** até confirmação humana.
- Editor completo de produto e substituição de foto.
- Creative Engine por templates 1080×1080 com Sharp, sem inventar o produto.
- Quality Gate com score, bloqueios de duplicação, produto inválido, hype sensível e confiança baixa.
- Índice recente de posts para evitar scan completo em todo refresh.
- Endpoint único `/api/bootstrap` para reduzir leituras duplicadas.
- Token Meta enviado em `Authorization: Bearer`, não em query string.
- Origin check, headers de segurança e API `no-store`.
- Coleta de reações, comentários e compartilhamentos; score entra na seleção futura de produto.
- Auditoria e health status das rotinas.

## Homologação segura

Mantenha:

```env
AUTO_PLAN=true
AUTO_APPROVE_PLANNER=false
AUTO_PUBLISH=false
```

Depois de alguns dias de revisão, ative primeiro `AUTO_APPROVE_PLANNER=true`. Só depois, se o Quality Gate estiver consistente, ative `AUTO_PUBLISH=true`.
