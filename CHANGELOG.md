# Changelog

## v0.7.0
- GPT Image 2 gera fundos/visuais reais; venda preserva a foto real do produto.
- Geração pesada migra para Background Function; Scheduled Functions viram dispatchers.
- Jobs manuais assíncronos com polling no painel.
- Imagem externa é validada e internalizada; mídia é revalidada antes de publicar.
- Hype guarda fontes/evidências e usa moderação + filtros de brand safety.
- Catálogo ganha frescor/stale, deduplicação no mesmo sync e auto-sync opcional.
- Quality Gate limita score quando há blocker e bloqueia URL na copy.
- Publicação recebe recovery de 10 minutos.
- Performance é comparada em janelas fixas de 24 h e 72 h.
- Índice de produtos elimina scans completos rotineiros.
- Mobile mantém IA/Meta/Atualizar visíveis e aumenta legibilidade.

## v0.5.0
- Métricas priorizam `post_id` da Meta quando disponível, preservando o ID do post de feed.
- Fail-safe: `AUTO_PLAN` fica desligado se não for explicitamente configurado como `true`.
- Scheduler dividido em rotinas JIT: 10 execuções/dia em vez de 96.
- Plano diário idempotente, retry limitado e orçamento de IA.
- Quality Gate recalculado após edição e antes da publicação.
- Shopee em modo descoberta + confirmação; URL canônica e determinística.
- Venda automática exige foto real do produto.
- Creative Engine 1080x1080, índices recentes, bootstrap único, métricas, health e audit log.
- Meta token via Bearer e proteção de Origin/CSP.

## v0.4.0

- Estratégia diária fixa: venda Shopee + hype atual + crescimento.
- Campo de link específico da Shopee por produto.
- Sincronização assistida da loja Shopee via OpenAI web search.
- Post de venda sempre inclui link exato do produto.
- Hype usa busca web no momento da criação e evita política, tragédias, boatos e temas sensíveis.
- Conteúdo de crescimento separado de conteúdo comercial.
- AUTO_PLAN garante o plano diário via Scheduled Function.
- AUTO_APPROVE_PLANNER controla se os posts já nascem aprovados.
- AUTO_PUBLISH permanece independente por segurança.
- Painel atualizado para mostrar estratégia, sincronização e origem dos produtos.
