import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalMessage, textSimilarity, plannerSlots, canonicalizeShopeeUrl } from '../netlify/lib/agent.mjs';

test('link Shopee é acrescentado deterministicamente uma única vez', () => {
  const post = { plannerType: 'sale', message: 'Confira esta caneca.', shopeeUrl: 'https://shopee.com.br/produto-123' };
  const final = buildFinalMessage(post);
  assert.match(final, /Veja o produto na Shopee/);
  assert.equal(final.split('https://shopee.com.br/produto-123').length - 1, 1);
});

test('post sem venda não recebe link', () => {
  assert.equal(buildFinalMessage({ plannerType: 'growth', message: 'Qual anime marcou você?', shopeeUrl: 'https://shopee.com.br/x' }), 'Qual anime marcou você?');
});

test('similaridade detecta cópia próxima', () => {
  assert.ok(textSimilarity('Qual anime marcou a sua infância e por quê?', 'Qual anime marcou sua infância? Conta pra gente por quê!') > 0.5);
});

test('slots padrão têm três horários', () => {
  assert.equal(plannerSlots().length, 3);
});


test('URL Shopee remove tracking e hash', () => {
  assert.equal(canonicalizeShopeeUrl('https://shopee.com.br/produto-123?utm_source=x#ref'), 'https://shopee.com.br/produto-123');
});

test('link da loja não pode ser usado como link de produto', () => {
  assert.throws(() => canonicalizeShopeeUrl('https://shopee.com.br/animacageek'), /link específico do produto/);
});

test('slots são fixos para coincidir com os crons de produção', () => {
  const before = process.env.PLANNER_SLOTS;
  process.env.PLANNER_SLOTS = '01:00,02:00,03:00';
  assert.deepEqual(plannerSlots(), ['10:00', '15:00', '20:00']);
  if (before === undefined) delete process.env.PLANNER_SLOTS; else process.env.PLANNER_SLOTS = before;
});
