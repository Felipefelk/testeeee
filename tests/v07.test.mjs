import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { copyHasUrl, stripUrls, sensitiveReasons, buildImagePrompt, extractWebEvidence, generateImageBuffer, moderateText } from '../netlify/lib/creative-ai.mjs';
import { productFreshnessState } from '../netlify/lib/agent.mjs';

test('copy de publicação detecta e remove URLs', () => {
  assert.equal(copyHasUrl('Veja https://example.com/x agora'), true);
  assert.equal(copyHasUrl('Sem link aqui'), false);
  assert.equal(stripUrls('Texto https://example.com/x\n\nFinal'), 'Texto\n\nFinal');
});

test('brand safety normaliza acentos e detecta tema sensível', () => {
  assert.ok(sensitiveReasons('Notícia sobre eleição e governo').includes('politica'));
  assert.ok(sensitiveReasons('Uma tragédia com vítimas').includes('tragedia'));
  assert.deepEqual(sensitiveReasons('Novo trailer de anime chegou'), []);
});

test('prompt de venda pede apenas fundo e proíbe produto/texto', () => {
  const prompt = buildImagePrompt({ type: 'sale', category: 'Canecas' }).toLowerCase();
  assert.match(prompt, /background/);
  assert.match(prompt, /do not include the product/);
  assert.match(prompt, /do not render any words/);
});

test('evidências web extraem apenas citações https', () => {
  const sources = extractWebEvidence({ output: [{ content: [{ annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'A' }, { url: 'http://inseguro.test' }] }] }] });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].domain, 'example.com');
});

test('ausência na busca gera atenção; idade vencida bloqueia catálogo', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');
  const base = { shopeeUrl: 'https://shopee.com.br/x', verified: true, verifiedAt: '2026-08-15T12:00:00Z' };
  assert.equal(productFreshnessState(base, now, 14).fresh, true);
  const missing = productFreshnessState({ ...base, missingSyncCount: 2 }, now, 14);
  assert.equal(missing.fresh, true);
  assert.equal(missing.state, 'attention');
  assert.equal(productFreshnessState({ ...base, verifiedAt: '2026-07-01T12:00:00Z' }, now, 14).fresh, false);
});

test('prepare é dispatcher e worker é background', () => {
  const prepare = fs.readFileSync(new URL('../netlify/functions/prepare-sale.mjs', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../netlify/functions/content-worker.mjs', import.meta.url), 'utf8');
  assert.match(prepare, /dispatchPrepareDailySlot/);
  assert.doesNotMatch(prepare, /prepareDailySlot\('sale'\)/);
  assert.match(worker, /background: true/);
});

test('publicação possui janela de recovery', () => {
  const sale = fs.readFileSync(new URL('../netlify/functions/publish-sale.mjs', import.meta.url), 'utf8');
  assert.match(sale, /0,10 13 \* \* \*/);
});

test('configuração padrão usa GPT Image 2 e falha segura', () => {
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /OPENAI_IMAGE_MODEL=gpt-image-2/);
  assert.match(env, /REQUIRE_AI_VISUAL=true/);
  assert.match(env, /AUTO_PUBLISH=false/);
});


test('Images API envia GPT Image 2 e devolve bytes base64', async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.alloc(2048, 7).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await generateImageBuffer({ apiKey: 'test-key', prompt: 'background', model: 'gpt-image-2', quality: 'low', fetchImpl });
  assert.equal(body.model, 'gpt-image-2');
  assert.equal(body.output_format, 'webp');
  assert.equal(result.buffer.length, 2048);
});

test('moderação interpreta flagged e categorias', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ results: [{ flagged: true, categories: { violence: true, sexual: false } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await moderateText({ apiKey: 'test-key', text: 'teste', fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ['violence']);
});

test('UI só considera produto com mídia interna e catálogo fresco', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /p\.mediaKey&&p\.catalogFresh!==false/);
  assert.doesNotMatch(app, /productReady\(p\).*mediaKey\|\|p\.imageUrl/);
});

test('sync manual e geração manual usam jobs de background', () => {
  const api = fs.readFileSync(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
  assert.match(api, /queueShopeeSync/);
  assert.match(api, /queueManualGeneration/);
});

test('performance coleta duas vezes ao dia e health usa nome estável', () => {
  const perf = fs.readFileSync(new URL('../netlify/functions/collect-performance.mjs', import.meta.url), 'utf8');
  assert.match(perf, /0 6,18 \* \* \*/);
  assert.match(perf, /collect-performance/);
});
