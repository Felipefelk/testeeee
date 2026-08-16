import { getStore } from '@netlify/blobs';
import OpenAI from 'openai';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { DateTime } from 'luxon';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';

export const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
export const SESSION_COOKIE = 'animaca_session';
export const SHOPEE_STORE_URL = process.env.SHOPEE_STORE_URL || 'https://shopee.com.br/animacageek';
const PUBLISH_LOCK_MS = 15 * 60 * 1000;

const productsStore = () => getStore({ name: 'animaca-products', consistency: 'strong' });
const postsStore = () => getStore({ name: 'animaca-posts', consistency: 'strong' });
const mediaStore = () => getStore({ name: 'animaca-media', consistency: 'strong' });
const systemStore = () => getStore({ name: 'animaca-system', consistency: 'strong' });

export function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.APP_PASSWORD) return crypto.createHash('sha256').update(`animaca:${process.env.APP_PASSWORD}`).digest('hex');
  return '';
}

export function signSession(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || !sessionSecret()) return false;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number(value.exp) > Date.now();
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isAuthenticated(req) {
  return verifySession(parseCookies(req.headers.get('cookie') || '')[SESSION_COOKIE]);
}

export function plannerSlots() {
  const raw = String(process.env.PLANNER_SLOTS || '10:00,15:00,20:00');
  const slots = raw.split(',').map(s => s.trim()).filter(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
  return slots.length >= 3 ? slots.slice(0, 3) : ['10:00', '15:00', '20:00'];
}

export function localToUtc(value) {
  if (!value) return null;
  const dt = DateTime.fromISO(String(value), { zone: TIMEZONE });
  if (!dt.isValid) throw new Error('Data/horário inválido.');
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

export function utcToLocal(value) {
  if (!value) return null;
  return DateTime.fromISO(value, { zone: 'utc' }).setZone(TIMEZONE).toFormat("yyyy-LL-dd'T'HH:mm");
}

export function validateHttpsUrl(raw, { optional = true } = {}) {
  const value = String(raw || '').trim();
  if (!value && optional) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') throw new Error();
    return u.toString();
  } catch {
    throw new Error('A URL precisa ser HTTPS válida.');
  }
}

function validateShopeeUrl(raw) {
  const value = validateHttpsUrl(raw);
  if (!value) return '';
  const u = new URL(value);
  if (!/(^|\.)shopee\.com\.br$/i.test(u.hostname)) throw new Error('O link da Shopee deve ser de shopee.com.br.');
  return value;
}

async function listJson(storeFactory, prefix) {
  const store = storeFactory();
  const { blobs } = await store.list({ prefix });
  const rows = await Promise.all(blobs.map(async b => store.get(b.key, { type: 'json', consistency: 'strong' })));
  return rows.filter(Boolean);
}

export async function listProducts() {
  const rows = await listJson(productsStore, 'product/');
  return rows.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || String(b.createdAt).localeCompare(String(a.createdAt))).map(productView);
}

export async function listPosts() {
  const rows = await listJson(postsStore, 'post/');
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(postView);
}

export function productView(p) {
  if (!p) return null;
  return { ...p, shopeeUrl: p.shopeeUrl || '', source: p.source || 'manual', mediaUrl: p.mediaKey ? `/media/${encodeURIComponent(p.mediaKey)}` : '' };
}

export function postView(p) {
  if (!p) return null;
  return { ...p, scheduledLocal: p.scheduledAt ? utcToLocal(p.scheduledAt) : null, mediaUrl: p.mediaKey ? `/media/${encodeURIComponent(p.mediaKey)}` : '' };
}

export async function getProduct(id) {
  const p = await productsStore().get(`product/${id}`, { type: 'json', consistency: 'strong' });
  return productView(p);
}

async function getPostEntry(id) {
  const entry = await postsStore().getWithMetadata(`post/${id}`, { type: 'json', consistency: 'strong' });
  if (!entry) return null;
  return { post: entry.data, etag: entry.etag };
}

export async function getPost(id) {
  const entry = await getPostEntry(id);
  return postView(entry?.post || null);
}

async function casPost(id, mutate, retries = 4) {
  const store = postsStore();
  for (let attempt = 0; attempt < retries; attempt++) {
    const entry = await getPostEntry(id);
    if (!entry) throw new Error('Post não encontrado.');
    const next = await mutate(structuredClone(entry.post));
    const result = await store.setJSON(`post/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) return postView(next);
  }
  const err = new Error('Conflito de atualização. Recarregue o painel e tente novamente.');
  err.status = 409;
  throw err;
}

async function casProduct(id, mutate, retries = 4) {
  const store = productsStore();
  for (let attempt = 0; attempt < retries; attempt++) {
    const entry = await store.getWithMetadata(`product/${id}`, { type: 'json', consistency: 'strong' });
    if (!entry) return null;
    const next = await mutate(structuredClone(entry.data));
    const result = await store.setJSON(`product/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) return productView(next);
  }
  return null;
}

export async function persistSafeImage(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) return null;
  if (file.size > 10 * 1024 * 1024) throw new Error('Imagem maior que 10 MB.');
  const bytes = Buffer.from(await file.arrayBuffer());
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) {
    throw new Error('O conteúdo do arquivo não corresponde a uma imagem JPEG, PNG ou WEBP válida.');
  }
  const output = await sharp(bytes, { failOn: 'error' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  const key = uuid();
  const result = await mediaStore().set(key, new Blob([output], { type: 'image/webp' }), { metadata: { mime: 'image/webp', createdAt: new Date().toISOString() }, onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível salvar a imagem.');
  return { mediaKey: key, imageMime: 'image/webp' };
}

export async function getMedia(key) {
  if (!/^[a-f0-9-]{30,50}$/i.test(String(key || ''))) return null;
  return mediaStore().getWithMetadata(String(key), { type: 'blob', consistency: 'strong' });
}

export async function createProduct({ name, category = '', price = '', description = '', imageUrl = '', shopeeUrl = '', file = null, source = 'manual' }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Nome do produto é obrigatório.');
  const saved = await persistSafeImage(file);
  const now = new Date().toISOString();
  const p = {
    id: uuid(), name: cleanName, category: String(category || '').trim(), price: String(price || '').trim(),
    description: String(description || '').trim(), imageUrl: validateHttpsUrl(imageUrl), shopeeUrl: validateShopeeUrl(shopeeUrl),
    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,
    lastPostedAt: null, createdAt: now, updatedAt: null
  };
  const result = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível cadastrar o produto.');
  return productView(p);
}

export async function updateProduct(id, body) {
  const updated = await casProduct(id, current => {
    if ('name' in body) { const n = String(body.name || '').trim(); if (!n) throw new Error('Nome é obrigatório.'); current.name = n; }
    if ('category' in body) current.category = String(body.category || '').trim();
    if ('price' in body) current.price = String(body.price || '').trim();
    if ('description' in body) current.description = String(body.description || '').trim();
    if ('shopeeUrl' in body) current.shopeeUrl = validateShopeeUrl(body.shopeeUrl);
    if ('active' in body) current.active = Boolean(body.active);
    current.updatedAt = new Date().toISOString();
    return current;
  });
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}

export async function deleteProduct(id) {
  const p = await getProduct(id);
  if (!p) return false;
  const posts = await listPosts();
  const mediaReferenced = p.mediaKey && posts.some(x => x.mediaKey === p.mediaKey);
  await productsStore().delete(`product/${id}`);
  if (p.mediaKey && !mediaReferenced) await mediaStore().delete(p.mediaKey);
  return { ok: true, mediaPreserved: Boolean(mediaReferenced) };
}

function openAIClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Configure OPENAI_API_KEY no Netlify.');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function recentPublishedText(limit = 14) {
  const rows = (await listPosts()).filter(p => p.status === 'published').sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))).slice(0, limit);
  return rows.map(p => `[${p.plannerType || p.origin || 'post'}] ${p.productName || 'institucional'}: ${p.message}`).join('\n---\n');
}

async function catalogDigest(limit = 18) {
  const rows = (await listProducts()).filter(p => p.active).slice(0, limit);
  return rows.map(p => `${p.name}${p.price ? ` (${p.price})` : ''}${p.shopeeUrl ? ` - ${p.shopeeUrl}` : ''}`).join('\n');
}

function salePrompt(product, recent) {
  return `Você é o agente de vendas da Animaca Geek, loja brasileira de personalizados e produtos geek.\n\nCrie UM post de Facebook para vender o produto abaixo.\nProduto: ${product.name}\nCategoria: ${product.category || 'não informada'}\nPreço: ${product.price || 'não informar preço'}\nDescrição factual: ${product.description || 'sem descrição adicional'}\nLink exato da Shopee: ${product.shopeeUrl}\n\nRegras obrigatórias:\n- Português do Brasil, linguagem humana e comercial, sem cara de IA.\n- Gancho forte na primeira linha.\n- Use apenas informações fornecidas; não invente estoque, prazo, frete, desconto ou avaliação.\n- Inclua o link EXATO da Shopee em uma linha própria e apenas uma vez.\n- CTA direto para clicar/comprar.\n- 3 a 6 hashtags relevantes no final.\n- Evite estrutura parecida com posts recentes.\n- Retorne somente o texto final do post.\n\nPosts recentes:\n${recent || 'Nenhum.'}`;
}

function growthPrompt(recent, catalog) {
  return `Você é o estrategista de crescimento orgânico da página Animaca Geek no Facebook. Crie UM post pensado principalmente para gerar comentários, compartilhamentos, identificação e novos seguidores, sem parecer caça-engajamento artificial.\n\nA marca trabalha com personalizados e universo geek. Você pode usar perguntas de preferência, escolhas, nostalgia, colecionismo, presentes, anime, games, filmes e cultura pop.\n\nRegras:\n- Português do Brasil.\n- 1 ideia central simples e fácil de responder.\n- Abra com um gancho curto.\n- Termine com uma pergunta específica que dê vontade de comentar.\n- Não invente fatos, promoções nem tendências.\n- Não inclua link de venda neste post.\n- 2 a 5 hashtags no final.\n- Não repita temas/estruturas dos posts recentes.\n- Retorne somente o post final.\n\nAlguns produtos/categorias da loja para contexto:\n${catalog || 'Catálogo não disponível.'}\n\nPosts recentes:\n${recent || 'Nenhum.'}`;
}

export async function generateSaleCaption(product) {
  if (!product?.shopeeUrl) throw new Error('O produto precisa ter um link específico da Shopee para o post de venda.');
  const client = openAIClient();
  const response = await client.responses.create({ model: process.env.OPENAI_MODEL || 'gpt-5.6', input: salePrompt(product, await recentPublishedText()), store: false });
  const message = response.output_text?.trim();
  if (!message) throw new Error('A IA não retornou a legenda de venda.');
  return message;
}

export async function generateGrowthPost() {
  const client = openAIClient();
  const response = await client.responses.create({ model: process.env.OPENAI_MODEL || 'gpt-5.6', input: growthPrompt(await recentPublishedText(), await catalogDigest()), store: false });
  const message = response.output_text?.trim();
  if (!message) throw new Error('A IA não retornou o post de crescimento.');
  return message;
}

export async function generateHypePost() {
  const client = openAIClient();
  const recent = await recentPublishedText();
  const prompt = `Pesquise na web AGORA e escolha UM assunto realmente atual dos últimos 3 dias que tenha forte afinidade com público geek brasileiro: anime, mangá, games, filmes/séries de cultura pop, trailers, lançamentos, eventos ou fandoms.\n\nCrie um post para a página Animaca Geek que aproveite esse hype para gerar alcance e conversa, sem inventar que a loja vende um produto específico relacionado ao tema.\n\nRegras de segurança/editorial:\n- Confirme pela busca que o assunto é recente. Se houver dúvida, escolha outro.\n- Evite política, tragédias, crimes, morte, polêmicas sensíveis, boatos e conteúdo adulto.\n- Não invente datas, anúncios ou fatos.\n- Não copie manchetes nem trechos longos de fontes.\n- Português do Brasil, tom geek natural, curto e compartilhável.\n- Não coloque links externos no post.\n- Termine com pergunta/conversa para comentários.\n- 2 a 5 hashtags.\n- Não use o mesmo tema ou estrutura dos posts recentes abaixo.\n- Retorne SOMENTE o texto pronto para Facebook, sem explicar a pesquisa e sem lista de fontes.\n\nPosts recentes:\n${recent || 'Nenhum.'}`;
  const response = await client.responses.create({ model: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6', tools: [{ type: 'web_search' }], input: prompt, store: false });
  const message = response.output_text?.trim();
  if (!message) throw new Error('A IA não encontrou um hype adequado agora.');
  return message;
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('A resposta de sincronização da Shopee não veio em JSON válido.');
}

export async function syncShopeeCatalog() {
  const client = openAIClient();
  const prompt = `Use a busca na web para inspecionar SOMENTE a loja Shopee ${SHOPEE_STORE_URL}. Encontre produtos reais atualmente visíveis dessa loja e seus links individuais.\n\nRetorne somente JSON neste formato exato:\n{"products":[{"name":"...","price":"R$ ...","url":"https://shopee.com.br/..."}]}\n\nRegras:\n- Máximo 30 produtos por sincronização.\n- Só inclua produtos que você consiga associar à loja AnimacaGeek e a um URL individual em shopee.com.br.\n- Não invente produto, preço ou URL.\n- Se não conseguir confirmar o URL individual, não inclua o item.\n- Não inclua explicações fora do JSON.`;
  const response = await client.responses.create({ model: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6', tools: [{ type: 'web_search' }], input: prompt, store: false });
  const parsed = extractJson(response.output_text);
  const incoming = Array.isArray(parsed.products) ? parsed.products : [];
  if (!incoming.length) throw new Error('Nenhum produto com link individual foi encontrado na sincronização.');
  const existing = await listProducts();
  const byUrl = new Map(existing.filter(p => p.shopeeUrl).map(p => [p.shopeeUrl, p]));
  const now = new Date().toISOString();
  let created = 0, updated = 0, ignored = 0;
  const samples = [];
  for (const item of incoming.slice(0, 30)) {
    try {
      const name = String(item.name || '').trim();
      const url = validateShopeeUrl(item.url);
      if (!name || !url) { ignored++; continue; }
      const old = byUrl.get(url);
      if (old) {
        await casProduct(old.id, p => ({ ...p, name, price: String(item.price || p.price || '').trim(), source: p.source || 'shopee_sync', active: true, updatedAt: now }));
        updated++;
      } else {
        const p = { id: uuid(), name, category: 'Shopee', price: String(item.price || '').trim(), description: 'Produto sincronizado da loja Shopee.', imageUrl: '', shopeeUrl: url, mediaKey: '', imageMime: '', active: true, source: 'shopee_sync', lastPostedAt: null, createdAt: now, updatedAt: null };
        const r = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
        if (r.modified) created++; else ignored++;
      }
      if (samples.length < 5) samples.push({ name, url });
    } catch { ignored++; }
  }
  await systemStore().setJSON('shopee-last-sync', { checkedAt: now, created, updated, ignored, found: incoming.length });
  return { storeUrl: SHOPEE_STORE_URL, found: incoming.length, created, updated, ignored, samples, checkedAt: now };
}

export async function insertPost({ product = null, displayName = '', message, imageUrl = '', mediaKey = '', imageMime = '', scheduledAt = null, origin = 'manual', plannerType = null, status = 'draft' }) {
  const clean = String(message || '').trim();
  if (!clean) throw new Error('Legenda é obrigatória.');
  const now = new Date().toISOString();
  const p = {
    id: uuid(), productId: product?.id || null, productName: product?.name || displayName || '', message: clean,
    imageUrl: imageUrl || product?.imageUrl || '', mediaKey: mediaKey || product?.mediaKey || '', imageMime: imageMime || product?.imageMime || '',
    shopeeUrl: product?.shopeeUrl || '', status, scheduledAt, createdAt: now, updatedAt: null, publishedAt: null,
    metaPostId: null, error: null, errorCode: null, errorSubcode: null, lastAttemptAt: null,
    publishToken: null, publishLockAt: null, origin, plannerType
  };
  const result = await postsStore().setJSON(`post/${p.id}`, p, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível criar o post.');
  return postView(p);
}

export async function patchPost(id, body) {
  return casPost(id, current => {
    if (['publishing', 'published'].includes(current.status)) {
      const e = new Error('Post em publicação ou já publicado não pode ser editado.'); e.status = 409; throw e;
    }
    if ('message' in body) { const m = String(body.message || '').trim(); if (!m) throw new Error('Legenda não pode ficar vazia.'); current.message = m; }
    if ('scheduledLocal' in body) current.scheduledAt = body.scheduledLocal ? localToUtc(body.scheduledLocal) : null;
    if ('imageUrl' in body) current.imageUrl = validateHttpsUrl(body.imageUrl);
    if ('status' in body) {
      if (!['draft', 'approved', 'cancelled'].includes(body.status)) throw new Error('Status inválido.');
      current.status = body.status; current.error = null; current.errorCode = null; current.errorSubcode = null;
    }
    current.updatedAt = new Date().toISOString();
    return current;
  });
}

export async function chooseSaleProduct() {
  const products = (await listProducts()).filter(p => p.active && p.shopeeUrl);
  if (!products.length) throw new Error('Nenhum produto ativo tem link específico da Shopee. Sincronize a loja ou adicione o link a um produto.');
  const posts = (await listPosts()).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const recentIds = new Set(posts.filter(p => p.plannerType === 'sale' && p.productId).slice(0, 5).map(p => p.productId));
  products.sort((a, b) => {
    const ar = recentIds.has(a.id) ? 1 : 0, br = recentIds.has(b.id) ? 1 : 0;
    if (ar !== br) return ar - br;
    return (a.lastPostedAt ? Date.parse(a.lastPostedAt) : 0) - (b.lastPostedAt ? Date.parse(b.lastPostedAt) : 0);
  });
  return products[0];
}

function plannerStatus() {
  return String(process.env.AUTO_APPROVE_PLANNER).toLowerCase() === 'true' ? 'approved' : 'draft';
}

export async function generatePlan(dateRaw) {
  const date = String(dateRaw || DateTime.now().setZone(TIMEZONE).toISODate());
  const d = DateTime.fromISO(date, { zone: TIMEZONE });
  if (!d.isValid) throw new Error('Data do Planner inválida.');
  const slots = plannerSlots();
  const currentPosts = await listPosts();
  const specs = [
    { type: 'sale', label: 'Venda Shopee', slot: slots[0] },
    { type: 'hype', label: 'Hype do momento', slot: slots[1] },
    { type: 'growth', label: 'Crescimento', slot: slots[2] }
  ];
  const created = [];
  const skipped = [];
  const status = plannerStatus();
  for (const spec of specs) {
    const scheduledAt = localToUtc(`${date}T${spec.slot}`);
    if (currentPosts.some(p => p.scheduledAt === scheduledAt && p.status !== 'cancelled')) { skipped.push(spec.type); continue; }
    if (spec.type === 'sale') {
      const product = await chooseSaleProduct();
      const message = await generateSaleCaption(product);
      created.push(await insertPost({ product, message, scheduledAt, origin: 'planner', plannerType: 'sale', status }));
    } else if (spec.type === 'hype') {
      const message = await generateHypePost();
      created.push(await insertPost({ displayName: spec.label, message, scheduledAt, origin: 'planner', plannerType: 'hype', status }));
    } else {
      const message = await generateGrowthPost();
      created.push(await insertPost({ displayName: spec.label, message, scheduledAt, origin: 'planner', plannerType: 'growth', status }));
    }
  }
  return { date, timezone: TIMEZONE, strategy: ['sale', 'hype', 'growth'], created, skipped, autoApproved: status === 'approved' };
}

export async function ensureDailyPlan() {
  if (String(process.env.AUTO_PLAN ?? 'true').toLowerCase() !== 'true') return { autoPlan: false, created: 0 };
  const now = DateTime.now().setZone(TIMEZONE);
  const date = now.toISODate();
  const posts = await listPosts();
  const daily = posts.filter(p => p.origin === 'planner' && String(p.scheduledLocal || '').startsWith(date) && p.status !== 'cancelled');
  const types = new Set(daily.map(p => p.plannerType));
  if (['sale', 'hype', 'growth'].every(t => types.has(t))) return { autoPlan: true, date, created: 0, alreadyComplete: true };
  const result = await generatePlan(date);
  return { autoPlan: true, date, created: result.created.length, skipped: result.skipped };
}

async function graphGet(endpoint, params = {}, token = process.env.META_PAGE_ACCESS_TOKEN) {
  const version = process.env.META_GRAPH_VERSION || 'v26.0';
  const url = new URL(`https://graph.facebook.com/${version}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (token) url.searchParams.set('access_token', token);
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) { const err = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`); err.code = json?.error?.code; err.subcode = json?.error?.error_subcode; throw err; }
  return json;
}

export async function validateMetaConnection(force = false) {
  if (!process.env.META_PAGE_ID || !process.env.META_PAGE_ACCESS_TOKEN) return { configured: false, valid: false, reason: 'META_PAGE_ID ou META_PAGE_ACCESS_TOKEN ausente.' };
  const cache = systemStore();
  if (!force) {
    const cached = await cache.get('meta-validation', { type: 'json', consistency: 'strong' });
    if (cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < 5 * 60 * 1000) return cached;
  }
  let value;
  try {
    const identity = await graphGet('me', { fields: 'id,name' });
    const matchesPage = String(identity.id) === String(process.env.META_PAGE_ID);
    let tasks = null, canCreateContent = null, taskValidationError = null;
    if (process.env.META_USER_ACCESS_TOKEN) {
      try {
        const pages = await graphGet('me/accounts', { fields: 'name,id,tasks', limit: 100 }, process.env.META_USER_ACCESS_TOKEN);
        const page = (pages.data || []).find(p => String(p.id) === String(process.env.META_PAGE_ID));
        tasks = page?.tasks || [];
        const accepted = ['CREATE_CONTENT', 'PROFILE_PLUS_CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_MANAGE', 'PROFILE_PLUS_FULL_CONTROL'];
        canCreateContent = Boolean(page && tasks.some(t => accepted.includes(t)));
      } catch (taskErr) { taskValidationError = taskErr.message; }
    }
    value = { configured: true, valid: matchesPage, pageId: identity.id, pageName: identity.name, matchesPage, tasks, canCreateContent, taskValidationError, checkedAt: new Date().toISOString(), reason: matchesPage ? null : 'O token respondeu por uma identidade diferente do META_PAGE_ID configurado.' };
  } catch (err) {
    value = { configured: true, valid: false, reason: err.message, code: err.code || null, subcode: err.subcode || null, checkedAt: new Date().toISOString() };
  }
  await cache.setJSON('meta-validation', value);
  return value;
}

async function graphPost(endpoint, body) {
  const version = process.env.META_GRAPH_VERSION || 'v26.0';
  const pageId = process.env.META_PAGE_ID;
  const url = `https://graph.facebook.com/${version}/${pageId}/${endpoint}`;
  let response;
  try { response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(20000) }); }
  catch (err) { const e = new Error(`Falha de rede ao chamar a Meta: ${err.message}`); e.ambiguous = true; throw e; }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`); e.code = json?.error?.code; e.subcode = json?.error?.error_subcode; throw e; }
  return json;
}

async function publishPost(post) {
  const meta = await validateMetaConnection(true);
  if (!meta.valid) throw new Error(`Conexão Meta inválida: ${meta.reason || 'token/página não validados.'}`);
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (post.mediaKey) {
    const entry = await mediaStore().get(post.mediaKey, { type: 'blob', consistency: 'strong' });
    if (entry) {
      const form = new FormData(); form.append('caption', post.message); form.append('access_token', token); form.append('source', entry, `${post.mediaKey}.webp`);
      return graphPost('photos', form);
    }
  }
  if (post.imageUrl) return graphPost('photos', new URLSearchParams({ url: post.imageUrl, caption: post.message, access_token: token }));
  return graphPost('feed', new URLSearchParams({ message: post.message, access_token: token }));
}

async function claimPost(id) {
  const store = postsStore();
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await getPostEntry(id);
    if (!entry) throw new Error('Post não encontrado.');
    const row = entry.post;
    if (row.status === 'published') return { already: true, post: postView(row) };
    if (row.status === 'publishing') {
      const age = Date.now() - Date.parse(row.publishLockAt || 0);
      if (age < PUBLISH_LOCK_MS) { const e = new Error('Este post já está em processo de publicação.'); e.status = 409; throw e; }
    }
    if (!['approved', 'publishing'].includes(row.status)) { const e = new Error('Apenas posts aprovados podem ser publicados. Revise e aprove novamente antes de tentar.'); e.status = 409; throw e; }
    const token = uuid(), now = new Date().toISOString();
    const next = { ...row, status: 'publishing', publishToken: token, publishLockAt: now, lastAttemptAt: now, error: null, errorCode: null, errorSubcode: null, updatedAt: now };
    const result = await store.setJSON(`post/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) return { already: false, token, post: postView(next) };
  }
  const e = new Error('Não foi possível obter o bloqueio de publicação; outra execução provavelmente já assumiu este post.'); e.status = 409; throw e;
}

export async function publishById(id) {
  const claim = await claimPost(id);
  if (claim.already) return claim.post;
  let metaAccepted = false;
  try {
    const result = await publishPost(claim.post);
    metaAccepted = true;
    const now = new Date().toISOString();
    const updated = await casPost(id, current => {
      if (current.publishToken !== claim.token) throw new Error('O post foi aceito pela Meta, mas o estado local mudou inesperadamente. Intervenção manual necessária.');
      return { ...current, status: 'published', publishedAt: now, metaPostId: result.id || result.post_id || null, error: null, errorCode: null, errorSubcode: null, publishToken: null, publishLockAt: null, updatedAt: now };
    });
    if (claim.post.productId) await casProduct(claim.post.productId, p => ({ ...p, lastPostedAt: now, updatedAt: now })).catch(err => console.error('[product-last-posted]', err));
    return updated;
  } catch (err) {
    const state = (err.ambiguous || metaAccepted) ? 'needs_review' : 'error';
    await casPost(id, current => current.publishToken !== claim.token ? current : ({ ...current, status: state, error: err.message, errorCode: String(err.code || ''), errorSubcode: String(err.subcode || ''), publishToken: null, publishLockAt: null, updatedAt: new Date().toISOString() })).catch(() => {});
    throw err;
  }
}

export async function publishDuePosts(limit = 10) {
  if (String(process.env.AUTO_PUBLISH).toLowerCase() !== 'true') return { autoPublish: false, attempted: 0, published: 0, errors: [] };
  const now = new Date().toISOString();
  const due = (await listPosts()).filter(p => p.status === 'approved' && p.scheduledAt && p.scheduledAt <= now).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).slice(0, limit);
  let published = 0; const errors = [];
  for (const post of due) { try { await publishById(post.id); published++; } catch (err) { errors.push({ id: post.id, error: err.message }); } }
  return { autoPublish: true, attempted: due.length, published, errors };
}

export async function statusSummary() {
  const [products, posts, meta, sync] = await Promise.all([
    listProducts(), listPosts(), validateMetaConnection(false), systemStore().get('shopee-last-sync', { type: 'json', consistency: 'strong' }).catch(() => null)
  ]);
  return {
    openai: Boolean(process.env.OPENAI_API_KEY), autoPlan: String(process.env.AUTO_PLAN ?? 'true').toLowerCase() === 'true',
    autoApprovePlanner: String(process.env.AUTO_APPROVE_PLANNER).toLowerCase() === 'true', autoPublish: String(process.env.AUTO_PUBLISH).toLowerCase() === 'true',
    graphVersion: process.env.META_GRAPH_VERSION || 'v26.0', timezone: TIMEZONE, plannerSlots: plannerSlots(), meta,
    shopee: { storeUrl: SHOPEE_STORE_URL, lastSync: sync || null, linkedProducts: products.filter(p => p.shopeeUrl).length },
    counts: { products: products.length, posts: posts.length, pending: posts.filter(p => ['draft', 'approved', 'error', 'needs_review'].includes(p.status)).length }
  };
}

export async function dataSummary() {
  const [products, posts] = await Promise.all([listProducts(), listPosts()]);
  return { products, posts, settings: { timezone: TIMEZONE, approvalRequired: true, plannerSlots: plannerSlots(), storage: 'Netlify Blobs', shopeeStoreUrl: SHOPEE_STORE_URL, strategy: ['sale', 'hype', 'growth'] } };
}

export async function checkLoginRate(ip) {
  const key = `login/${crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex')}`;
  const store = systemStore(); const now = Date.now(); const windowMs = 15 * 60 * 1000; const max = 5;
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (!entry) { const value = { first: now, count: 1 }; const result = await store.setJSON(key, value, { onlyIfNew: true }); if (result.modified) return true; continue; }
    let rec = entry.data || { first: now, count: 0 };
    if (now - Number(rec.first || 0) > windowMs) rec = { first: now, count: 0 };
    rec.count += 1;
    const result = await store.setJSON(key, rec, { onlyIfMatch: entry.etag });
    if (result.modified) return rec.count <= max;
  }
  return false;
}

export async function resetLoginRate(ip) {
  const key = `login/${crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex')}`;
  await systemStore().delete(key).catch(() => {});
}
