# Animaca Geek Facebook Agent v0.4

Agente serverless no Netlify para planejar, revisar e publicar conteúdo na Página do Facebook da Animaca Geek.

## Estratégia diária fixa

1. **10h — Venda Shopee:** escolhe um produto ativo menos repetido, cria copy comercial e inclui o link específico do produto na Shopee.
2. **15h — Hype do momento:** usa a ferramenta de busca web da OpenAI para localizar um assunto geek realmente recente e criar um post de alcance/conversa.
3. **20h — Crescimento:** cria conteúdo pensado para comentários, compartilhamentos, identificação e novos seguidores.

## Shopee

- `SHOPEE_STORE_URL` aponta para a loja pública.
- O painel tem **Sincronizar produtos da Shopee**, que usa web search da OpenAI e só importa itens em que consegue confirmar um URL individual.
- Produtos também podem ser cadastrados manualmente com foto, preço e link específico.
- Produtos sincronizados sem foto podem gerar posts de texto; adicione fotos reais aos produtos prioritários quando quiser posts de venda com imagem.

## Automação

- `AUTO_PLAN=true`: o scheduler garante o plano do dia automaticamente.
- `AUTO_APPROVE_PLANNER=false`: os 3 posts nascem como rascunho para revisão.
- `AUTO_PUBLISH=false`: nada é publicado automaticamente.

Para autonomia total, depois de homologar:

```env
AUTO_PLAN=true
AUTO_APPROVE_PLANNER=true
AUTO_PUBLISH=true
```

## Segurança

Tokens e chaves ficam somente nas Environment Variables do Netlify. Não versione `.env`.
