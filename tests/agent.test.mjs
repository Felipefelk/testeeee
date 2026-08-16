import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalMessage, textSimilarity, plannerSlots } from '../netlify/lib/agent.mjs';

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
