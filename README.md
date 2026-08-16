# Animaca Geek Facebook Agent v0.7

Agente serverless para Netlify com três frentes diárias: **Venda Shopee → Hype do momento → Crescimento**. A v0.7 transforma o antigo “Creative Engine” de template em um pipeline visual real: **GPT Image 2 gera o cenário; Sharp compõe a foto real do produto, tipografia e marca**.

## Arquitetura v0.7

- Scheduled Functions ficam leves e apenas disparam trabalho.
- `content-worker` é Background Function para copy, web search e geração de imagem, evitando o limite de 30 s do scheduler.
- Publicação Meta continua em função curta, com execução principal e recovery 10 minutos depois.
- Jobs manuais também usam o worker e o painel acompanha até concluir.

## Segurança visual e comercial

- Venda nunca pede para a IA inventar o produto: o GPT Image 2 gera somente o fundo/cenário; a foto real cadastrada é composta por cima.
- Imagens por URL são baixadas, validadas e internalizadas no Netlify Blobs.
- Post automático só publica se a mídia interna ainda existir.
- Copy não pode carregar URL; o link Shopee continua sendo acrescentado deterministicamente pelo servidor.
- Hype guarda evidências da busca web e passa por filtro local + `omni-moderation-latest`.
- Quality Gate com blocker nunca pode aparecer como 100/100.

## Loja Shopee

- `AUTO_SYNC_SHOPEE=true` habilita uma busca diária às 08:30 BRT em Background Function.
- Produtos não encontrados repetidamente ficam `stale` e saem da rotação automática.
- Itens novos encontrados continuam exigindo confirmação humana e foto real antes de vender.

## Horários

- 09:15/09:35 BRT: prepara venda.
- 10:00 + recovery 10:10: publica venda.
- 14:15/14:35: prepara hype.
- 15:00 + recovery 15:10: publica hype.
- 19:15/19:35: prepara crescimento.
- 20:00 + recovery 20:10: publica crescimento.
- 03:00: métricas com snapshots de 24 h e 72 h.
- 08:30: sync Shopee opcional.
- domingo 03:30: limpeza em background.

## Homologação

Mantenha inicialmente:

```env
AUTO_PLAN=false
AUTO_APPROVE_PLANNER=false
AUTO_PUBLISH=false
AUTO_SYNC_SHOPEE=false
REQUIRE_AI_VISUAL=true
```

Teste manualmente Venda, Hype e Crescimento. Depois ligue `AUTO_PLAN`, em seguida `AUTO_SYNC_SHOPEE`, depois aprovação automática e por último publicação automática.

Nunca coloque tokens ou chaves no GitHub.
