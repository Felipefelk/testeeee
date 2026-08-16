from pathlib import Path

p = Path('netlify/lib/agent.mjs')
s = p.read_text()

old = """export function plannerSlots() {
  const raw = String(process.env.PLANNER_SLOTS || '10:00,15:00,20:00');
  const slots = raw.split(',').map(s => s.trim()).filter(s => /^([01]\\d|2[0-3]):[0-5]\\d$/.test(s));
  return slots.length >= 3 ? slots.slice(0, 3) : ['10:00', '15:00', '20:00'];
}
"""
new = """const FIXED_PLANNER_SLOTS = Object.freeze(['10:00', '15:00', '20:00']);

export function plannerSlots() {
  // Os crons da v0.5 são fixos nesses horários; configuração divergente criaria drift.
  return [...FIXED_PLANNER_SLOTS];
}
"""
assert old in s, 'plannerSlots não encontrado'
s = s.replace(old, new)

old = """function validateShopeeUrl(raw) {
  const value = validateHttpsUrl(raw);
  if (!value) return '';
  const u = new URL(value);
  if (!/(^|\\.)shopee\\.com\\.br$/i.test(u.hostname)) throw new Error('O link da Shopee deve ser de shopee.com.br.');
  return value;
}
"""
new = """export function canonicalizeShopeeUrl(raw) {
  const value = validateHttpsUrl(raw);
  if (!value) return '';
  const u = new URL(value);
  if (!/(^|\\.)shopee\\.com\\.br$/i.test(u.hostname)) throw new Error('O link da Shopee deve ser de shopee.com.br.');
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\\/{2,}/g, '/').replace(/\\/$/, '') || '/';
  const store = new URL(SHOPEE_STORE_URL);
  const storePath = store.pathname.replace(/\\/$/, '') || '/';
  if (u.hostname.toLowerCase() === store.hostname.toLowerCase() && (u.pathname === '/' || u.pathname.toLowerCase() === storePath.toLowerCase())) {
    throw new Error('Use o link específico do produto, não o link da loja Shopee.');
  }
  return u.toString();
}

const parseBooleanInput = value => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'sim', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'não', 'nao', 'off', ''].includes(raw)) return false;
  throw new Error('Valor booleano inválido.');
};
"""
assert old in s, 'validateShopeeUrl não encontrado'
s = s.replace(old, new)
s = s.replace('validateShopeeUrl(shopeeUrl)', 'canonicalizeShopeeUrl(shopeeUrl)')
s = s.replace('validateShopeeUrl(body.shopeeUrl)', 'canonicalizeShopeeUrl(body.shopeeUrl)')
s = s.replace('validateShopeeUrl(item.url)', 'canonicalizeShopeeUrl(item.url)')
s = s.replace("if ('active' in body) current.active = Boolean(body.active);", "if ('active' in body) current.active = parseBooleanInput(body.active);")

old = "    if (!product?.mediaKey && !product?.imageUrl) { score -= 10; warnings.push('produto sem foto real cadastrada'); }"
assert old in s, 'regra de foto não encontrada'
s = s.replace(old, "    if (!product?.mediaKey && !product?.imageUrl) blockers.push('produto sem foto real cadastrada');")

start = s.index('export async function patchPost(id, body) {')
end = s.index('\n\nexport async function chooseSaleProduct()', start)
s = s[:start] + """export async function patchPost(id, body) {
  const updated = await casPost(id, async current => {
    if (['publishing', 'published'].includes(current.status)) {
      const e = new Error('Post em publicação ou já publicado não pode ser editado.'); e.status = 409; throw e;
    }
    const contentChanged = 'message' in body || 'imageUrl' in body;
    if ('message' in body) {
      const m = String(body.message || '').trim();
      if (!m) throw new Error('Legenda não pode ficar vazia.');
      current.message = m;
    }
    if ('scheduledLocal' in body) current.scheduledAt = body.scheduledLocal ? localToUtc(body.scheduledLocal) : null;
    if ('imageUrl' in body) current.imageUrl = validateHttpsUrl(body.imageUrl);
    if (contentChanged && current.status === 'approved' && !('status' in body)) current.status = 'draft';
    const requestedStatus = 'status' in body ? body.status : null;
    if (requestedStatus && !['draft', 'approved', 'cancelled'].includes(requestedStatus)) throw new Error('Status inválido.');
    const product = current.productId ? await getProduct(current.productId) : null;
    current.quality = await qualityGate(current, product);
    if (requestedStatus === 'approved') {
      if (current.quality.blockers.length) throw new Error(`Quality Gate bloqueou: ${current.quality.blockers.join('; ')}`);
      current.status = 'approved';
      current.error = null; current.errorCode = null; current.errorSubcode = null;
    } else if (requestedStatus) {
      current.status = requestedStatus;
      current.error = null; current.errorCode = null; current.errorSubcode = null;
    }
    current.updatedAt = nowIso();
    return current;
  });
  if (updated.dailyDate && updated.plannerType && body.status === 'cancelled') {
    await markPlanSlot(updated.dailyDate, updated.plannerType, { state: 'cancelled', postId: updated.id });
  }
  return updated;
}
""" + s[end:]

old = """async function validateBeforePublish(post) {
  if (!post) throw new Error('Post não encontrado.');
  if (post.quality?.blockers?.length) throw new Error(`Quality Gate bloqueou: ${post.quality.blockers.join('; ')}`);
  if (post.plannerType === 'sale') {
    const product = await getProduct(post.productId);
    if (!product || !product.active || !product.verified) throw new Error('Produto da venda está inativo, ausente ou não confirmado.');
    if (product.shopeeUrl !== post.shopeeUrl) throw new Error('O link atual do produto mudou; revise o post antes de publicar.');
  }
  if (post.plannerType === 'hype' && Date.now() - Date.parse(post.createdAt) > 4 * 3600_000) throw new Error('Post de hype ficou velho demais; gere um novo assunto.');
  return true;
}
"""
new = """async function validateBeforePublish(post) {
  if (!post) throw new Error('Post não encontrado.');
  const product = post.productId ? await getProduct(post.productId) : null;
  const freshQuality = await qualityGate(post, product);
  if (freshQuality.blockers.length) throw new Error(`Quality Gate bloqueou: ${freshQuality.blockers.join('; ')}`);
  if (post.plannerType === 'sale') {
    if (!product || !product.active || !product.verified) throw new Error('Produto da venda está inativo, ausente ou não confirmado.');
    if (product.shopeeUrl !== post.shopeeUrl) throw new Error('O link atual do produto mudou; revise o post antes de publicar.');
  }
  if (post.plannerType === 'hype' && Date.now() - Date.parse(post.createdAt) > 4 * 3600_000) throw new Error('Post de hype ficou velho demais; gere um novo assunto.');
  return true;
}
"""
assert old in s, 'validateBeforePublish não encontrado'
s = s.replace(old, new)
p.write_text(s)

env = Path('.env.example')
e = env.read_text().replace('PLANNER_SLOTS=10:00,15:00,20:00\n', '')
env.write_text(e)

readme = Path('README.md')
r = readme.read_text()
r = r.replace('Total normal: 10 Scheduled Function runs/dia, contra 96/dia na v0.4.', 'Total normal: 10 Scheduled Function runs/dia, contra 96/dia na v0.4. Os horários 10h/15h/20h são fixos na v0.5 para nunca divergir dos crons do Netlify.')
r = r.replace('- Link Shopee não é escrito pela IA: o servidor acrescenta a URL canônica no momento da publicação.', '- Link Shopee não é escrito pela IA: o servidor canonicaliza (remove tracking), rejeita link da loja e acrescenta a URL exata no momento da publicação.')
r = r.replace('- Quality Gate com score, bloqueios de duplicação, produto inválido, hype sensível e confiança baixa.', '- Quality Gate recalculado após edição e novamente antes de publicar; bloqueia duplicação, produto inválido/sem foto real, hype sensível e confiança baixa.')
readme.write_text(r)

tests = Path('tests/agent.test.mjs')
t = tests.read_text().replace("import { buildFinalMessage, textSimilarity, plannerSlots } from '../netlify/lib/agent.mjs';", "import { buildFinalMessage, textSimilarity, plannerSlots, canonicalizeShopeeUrl } from '../netlify/lib/agent.mjs';")
t += """

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
"""
tests.write_text(t)

ch = Path('CHANGELOG.md')
old_ch = ch.read_text() if ch.exists() else ''
entry = """# Changelog\n\n## v0.5.0\n- Scheduler dividido em rotinas JIT: 10 execuções/dia em vez de 96.\n- Plano diário idempotente, retry limitado e orçamento de IA.\n- Quality Gate recalculado após edição e antes da publicação.\n- Shopee em modo descoberta + confirmação; URL canônica e determinística.\n- Venda automática exige foto real do produto.\n- Creative Engine 1080x1080, índices recentes, bootstrap único, métricas, health e audit log.\n- Meta token via Bearer e proteção de Origin/CSP.\n\n"""
if '## v0.5.0' not in old_ch:
    ch.write_text(entry + old_ch.replace('# Changelog\n\n', ''))
