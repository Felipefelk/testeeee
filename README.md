# Animaca Geek Facebook Agent v0.6

Agente serverless para Netlify que opera três frentes diárias: **Venda Shopee → Hype do momento → Crescimento**, com autonomia progressiva, Quality Gate, métricas e controle de custos.

## Estratégia diária

- **09:15/09:35 BRT**: prepara a venda das 10h; a segunda janela é retry controlado.
- **10:00 BRT**: publica a venda aprovada.
- **14:15/14:35 BRT**: pesquisa e prepara o hype das 15h.
- **15:00 BRT**: publica o hype aprovado.
- **19:15/19:35 BRT**: prepara o conteúdo de crescimento das 20h.
- **20:00 BRT**: publica o crescimento aprovado.
- **03:00 BRT**: coleta performance recente.
- **Domingo 03:30 BRT**: remove mídias órfãs antigas de forma conservadora.

O fluxo normal usa cerca de 10 execuções diárias de preparação/publicação, em vez das 96 verificações diárias da v0.4.

## O que mudou na v0.6

### Segurança e confiabilidade
- Lock de publicação expirado vai para `needs_review`; nunca republica automaticamente.
- HTTP 5xx/408 da Meta é tratado como resultado potencialmente ambíguo.
- Estado incerto pode ser encerrado manualmente como “já está no Facebook” ou “não publicou”.
- Origin check, CSP sem `unsafe-inline`, token Meta via `Authorization: Bearer` e API `no-store`.
- Imagens remotas têm proteção contra destinos privados e limite real durante streaming.

### Shopee e produtos
- Link Shopee é inserido pelo servidor, nunca pela IA.
- URL é canonicalizada e shortlinks `s.shopee.com.br` têm resolução segura quando possível.
- Cadastro duplicado pelo mesmo link é bloqueado.
- Produto automático só entra na rotação quando estiver ativo, confirmado, com link e foto real.
- Alterar preço/descrição não desconfirma o produto; somente mudança real de URL exige nova confirmação.

### Conteúdo e visual
- Creative Engine v2 cria artes 1080×1080 predominantemente brancas, com seis variações e foto real nas vendas.
- Hype e crescimento recebem composição visual própria sem inventar produto.
- O painel permite refazer a arte ou voltar à foto original.
- Preview no estilo Facebook mostra o resultado final antes da aprovação.
- Testes de Venda, Hype e Crescimento podem ser criados a qualquer momento como rascunho.

### Operação
- Dashboard dividido em Hoje, Conteúdo, Produtos, Automação, Métricas e Sistema.
- Central “Hoje” mostra os três slots e o que precisa de revisão.
- Estados são traduzidos na interface.
- Catálogo e posts têm busca/filtros.
- Auditoria é apresentada em linguagem operacional, com detalhes técnicos recolhidos.
- Saúde distingue Saudável, Atenção, Erro e Desligado.

### Eficiência e aprendizado
- Budget diário separado para copy, web e sincronização.
- Painel mostra uso/limite e modelos configurados.
- Performance do produto é recalculada a partir de amostras únicas, evitando somar repetidamente a mesma medição.
- Rotação considera vendas realmente publicadas, não rascunhos cancelados.
- Índice recente evita scan completo do histórico a cada refresh.

## Homologação segura

Comece com:

```env
AUTO_PLAN=false
AUTO_APPROVE_PLANNER=false
AUTO_PUBLISH=false
```

Depois avance em três fases:

1. `AUTO_PLAN=true` — o agente prepara sozinho, mas você revisa.
2. `AUTO_APPROVE_PLANNER=true` — somente posts que passarem no Quality Gate podem ser aprovados automaticamente.
3. `AUTO_PUBLISH=true` — libere apenas depois de homologar visual, conteúdo, Shopee e Meta.

Nunca coloque tokens ou chaves no GitHub. Secrets permanecem apenas nas variáveis de ambiente do Netlify.
