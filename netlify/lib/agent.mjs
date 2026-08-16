import { getStore } from '@netlify/blobs';
import OpenAI from 'openai';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { DateTime } from 'luxon';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
export const SESSION_COOKIE = 'animaca_session';
export const SHOPEE_STORE_URL = process.env.SHOPEE_STORE_URL || 'https://shopee.com.br/animacageek';
const PUBLISH_LOCK_MS = 15 * 60 * 1000;
const POST_INDEX_LIMIT = 120;
const SLOT_MAX_ATTEMPTS = 2;
const SLOT_RETRY_MINUTES = 10;
const PLAN_TYPES = ['sale', 'hype', 'growth'];

const productsStore = () => getStore({ name: 'animaca-products', consistency: 'strong' });
const postsStore = () => getStore({ name: 'animaca-posts', consistency: 'strong' });
const mediaStore = () => getStore({ name: 'animaca-media', consistency: 'strong' });
const systemStore = () => getStore({ name: 'animaca-system', consistency: 'strong' });

const nowIso = () => new Date().toISOString();
const boolEnv = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
};
const intEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

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

const FIXED_PLANNER_SLOTS = Object.freeze(['10:00', '15:00', '20:00']);

export function plannerSlots() {
  // Os crons da v0.5 são fixos nesses horários; configuração divergente criaria drift.
  return [...FIXED_PLANNER_SLOTS];
}

function typeSpec(type) {
  const slots = plannerSlots();
  const map = {
    sale: { type: 'sale', label: 'Venda Shopee', slot: slots[0] },
    hype: { type: 'hype', label: 'Hype do momento', slot: slots[1] },
    growth: { type: 'growth', label: 'Crescimento', slot: slots[2] }
  };
  if (!map[type]) throw new Error(`Tipo de conteúdo inválido: ${type}`);
  return map[type];
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

export function canonicalizeShopeeUrl(raw) {
  const value = validateHttpsUrl(raw);
  if (!value) return '';
  const u = new URL(value);
  if (!/(^|\.)shopee\.com\.br$/i.test(u.hostname)) throw new Error('O link da Shopee deve ser de shopee.com.br.');
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  const store = new URL(SHOPEE_STORE_URL);
  const storePath = store.pathname.replace(/\/$/, '') || '/';
  if (u.hostname.toLowerCase() === store.hostname.toLowerCase() && (u.pathname === '/' || u.pathname.toLowerCase() === storePath.toLowerCase())) {
    throw new Error('Use o link específico do produto, não o link da loja Shopee.');
  }
  return u.toString();
}


export function isPrivateAddress(address) {
  const raw = String(address || '').trim().toLowerCase();
  const version = net.isIP(raw);
  if (version === 4) {
    const p = raw.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (version === 6) {
    if (raw === '::' || raw === '::1') return true;
    if (raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') || raw.startsWith('feb')) return true;
    if (raw.startsWith('::ffff:')) return isPrivateAddress(raw.slice(7));
  }
  return false;
}

async function assertPublicHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Destino de imagem não permitido.');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Destino de imagem privado não permitido.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(x => isPrivateAddress(x.address))) throw new Error('Destino de imagem privado não permitido.');
}

async function fetchPublicHttps(raw, { headers = {}, timeout = 7000, maxRedirects = 4 } = {}) {
  let current = new URL(validateHttpsUrl(raw, { optional: false }));
  for (let n = 0; n <= maxRedirects; n++) {
    await assertPublicHostname(current.hostname);
    const response = await fetch(current, { redirect: 'manual', headers, signal: AbortSignal.timeout(timeout) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      response.body?.cancel().catch(() => {});
      if (!loc) throw new Error('Redirecionamento sem destino.');
      const next = new URL(loc, current);
      if (next.protocol !== 'https:') throw new Error('Redirecionamento inseguro bloqueado.');
      current = next;
      continue;
    }
    return { response, finalUrl: current.toString() };
  }
  throw new Error('Redirecionamentos demais.');
}

async function readResponseLimited(response, maxBytes = 10 * 1024 * 1024) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error('Imagem remota maior que 10 MB.');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Imagem remota maior que 10 MB.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function normalizeShopeeUrl(raw) {
  let value = canonicalizeShopeeUrl(raw);
  if (!value) return '';
  let current = new URL(value);
  if (current.hostname.toLowerCase() !== 's.shopee.com.br') return value;
  try {
    for (let n = 0; n < 5; n++) {
      const response = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; AnimacaGeekAgent/0.6)' },
        signal: AbortSignal.timeout(6500)
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        response.body?.cancel().catch(() => {});
        break;
      }
      const loc = response.headers.get('location');
      response.body?.cancel().catch(() => {});
      if (!loc) break;
      const next = new URL(loc, current);
      if (next.protocol !== 'https:' || !/(^|\.)shopee\.com\.br$/i.test(next.hostname)) throw new Error('Redirecionamento Shopee inválido.');
      current = next;
      if (current.hostname.toLowerCase() !== 's.shopee.com.br') break;
    }
    value = canonicalizeShopeeUrl(current.toString());
  } catch (err) {
    console.warn('[shopee-shortlink]', err.message);
  }
  return value;
}

const parseBooleanInput = value => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'sim', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'não', 'nao', 'off', ''].includes(raw)) return false;
  throw new Error('Valor booleano inválido.');
};

async function listJson(storeFactory, prefix) {
  const store = storeFactory();
  const { blobs } = await store.list({ prefix });
  const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json', consistency: 'strong' })));
  return rows.filter(Boolean);
}

async function mutateSystemJson(key, initialValue, mutate, retries = 6) {
  const store = systemStore();
  for (let attempt = 0; attempt < retries; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const current = entry?.data ?? structuredClone(initialValue);
    const next = await mutate(structuredClone(current));
    const result = entry
      ? await store.setJSON(key, next, { onlyIfMatch: entry.etag })
      : await store.setJSON(key, next, { onlyIfNew: true });
    if (result.modified) return next;
  }
  const err = new Error(`Conflito de atualização em ${key}.`);
  err.status = 409;
  throw err;
}

function compactPost(p) {
  if (!p) return null;
  const keys = [
    'id','productId','productName','message','imageUrl','mediaKey','imageMime','shopeeUrl','status','scheduledAt',
    'createdAt','updatedAt','publishedAt','metaPostId','error','errorCode','errorSubcode','lastAttemptAt','origin',
    'plannerType','topic','dailyDate','quality','performance','generatedVisual'
  ];
  return Object.fromEntries(keys.map(k => [k, p[k] ?? null]));
}

async function ensurePostIndex() {
  const store = systemStore();
  const existing = await store.get('indexes/posts-v2', { type: 'json', consistency: 'strong' });
  if (existing?.version === 2) return existing;
  const rows = await listJson(postsStore, 'post/');
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const index = { version: 2, totalPosts: rows.length, items: rows.slice(0, POST_INDEX_LIMIT).map(compactPost), rebuiltAt: nowIso() };
  const result = await store.setJSON('indexes/posts-v2', index, { onlyIfNew: true });
  if (result.modified) return index;
  return await store.get('indexes/posts-v2', { type: 'json', consistency: 'strong' }) || index;
}

async function indexPost(post, { isNew = false } = {}) {
  await ensurePostIndex();
  return mutateSystemJson('indexes/posts-v2', { version: 2, totalPosts: 0, items: [] }, idx => {
    idx.version = 2;
    idx.items = Array.isArray(idx.items) ? idx.items : [];
    const found = idx.items.findIndex(x => x.id === post.id);
    if (found >= 0) idx.items.splice(found, 1);
    idx.items.unshift(compactPost(post));
    idx.items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    idx.items = idx.items.slice(0, POST_INDEX_LIMIT);
    if (isNew && found < 0) idx.totalPosts = Number(idx.totalPosts || 0) + 1;
    idx.updatedAt = nowIso();
    return idx;
  });
}

export async function listRecentPosts(limit = 60) {
  const idx = await ensurePostIndex();
  return (idx.items || []).slice(0, Math.max(1, Math.min(limit, POST_INDEX_LIMIT))).map(postView);
}

export async function listProducts() {
  const rows = await listJson(productsStore, 'product/');
  return rows.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || String(b.createdAt).localeCompare(String(a.createdAt))).map(productView);
}

export function productView(p) {
  if (!p) return null;
  return {
    ...p,
    shopeeUrl: p.shopeeUrl || '', source: p.source || 'manual', verified: Boolean(p.verified),
    mediaUrl: p.mediaKey ? `/media/${encodeURIComponent(p.mediaKey)}` : ''
  };
}

export function buildFinalMessage(post) {
  const base = String(post?.message || '').trim();
  if (post?.plannerType !== 'sale' || !post?.shopeeUrl) return base;
  return `${base}\n\n🛒 Veja o produto na Shopee:\n${post.shopeeUrl}`;
}

export function postView(p) {
  if (!p) return null;
  return {
    ...p,
    scheduledLocal: p.scheduledAt ? utcToLocal(p.scheduledAt) : null,
    mediaUrl: p.mediaKey ? `/media/${encodeURIComponent(p.mediaKey)}` : '',
    finalMessage: buildFinalMessage(p)
  };
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

async function casPost(id, mutate, retries = 5) {
  const store = postsStore();
  for (let attempt = 0; attempt < retries; attempt++) {
    const entry = await getPostEntry(id);
    if (!entry) throw new Error('Post não encontrado.');
    const next = await mutate(structuredClone(entry.post));
    const result = await store.setJSON(`post/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) {
      await indexPost(next).catch(err => console.error('[post-index]', err));
      return postView(next);
    }
  }
  const err = new Error('Conflito de atualização. Recarregue o painel e tente novamente.');
  err.status = 409;
  throw err;
}

async function casProduct(id, mutate, retries = 5) {
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
    throw new Error('O conteúdo do arquivo não corresponde a JPEG, PNG ou WEBP válido.');
  }
  const output = await sharp(bytes, { failOn: 'error' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  return saveGeneratedMedia(output, { mime: 'image/webp', source: 'upload' });
}

async function saveGeneratedMedia(buffer, metadata = {}) {
  const key = uuid();
  const result = await mediaStore().set(key, new Blob([buffer], { type: metadata.mime || 'image/webp' }), {
    metadata: { mime: metadata.mime || 'image/webp', createdAt: nowIso(), ...metadata }, onlyIfNew: true
  });
  if (!result.modified) throw new Error('Não foi possível salvar a imagem.');
  return { mediaKey: key, imageMime: metadata.mime || 'image/webp' };
}

export async function getMedia(key) {
  if (!/^[a-f0-9-]{30,50}$/i.test(String(key || ''))) return null;
  return mediaStore().getWithMetadata(String(key), { type: 'blob', consistency: 'strong' });
}

export async function createProduct({ name, category = '', price = '', description = '', imageUrl = '', shopeeUrl = '', file = null, source = 'manual' }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Nome do produto é obrigatório.');
  const saved = await persistSafeImage(file);
  const link = await normalizeShopeeUrl(shopeeUrl);
  if (link) {
    const duplicate = (await listProducts()).find(p => p.shopeeUrl === link);
    if (duplicate) { const e = new Error(`Este link da Shopee já pertence ao produto “${duplicate.name}”.`); e.status = 409; throw e; }
  }
  const now = nowIso();
  const p = {
    id: uuid(), name: cleanName, category: String(category || '').trim(), price: String(price || '').trim(),
    description: String(description || '').trim(), imageUrl: validateHttpsUrl(imageUrl), shopeeUrl: link,
    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,
    verified: Boolean(link), verifiedAt: link ? now : null, observedPrice: '', lastSyncSeenAt: null,
    lastPostedAt: null, performanceScore: 0, createdAt: now, updatedAt: null
  };
  const result = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível cadastrar o produto.');
  return productView(p);
}

export async function updateProduct(id, body) {
  const updated = await casProduct(id, async current => {
    if ('name' in body) { const n = String(body.name || '').trim(); if (!n) throw new Error('Nome é obrigatório.'); current.name = n; }
    if ('category' in body) current.category = String(body.category || '').trim();
    if ('price' in body) current.price = String(body.price || '').trim();
    if ('description' in body) current.description = String(body.description || '').trim();
    if ('imageUrl' in body) current.imageUrl = validateHttpsUrl(body.imageUrl);
    if ('shopeeUrl' in body) {
      const nextUrl = await normalizeShopeeUrl(body.shopeeUrl);
      if (nextUrl !== (current.shopeeUrl || '')) {
        if (nextUrl) {
          const duplicate = (await listProducts()).find(p => p.id !== id && p.shopeeUrl === nextUrl);
          if (duplicate) { const e = new Error(`Este link da Shopee já pertence ao produto “${duplicate.name}”.`); e.status = 409; throw e; }
        }
        current.shopeeUrl = nextUrl;
        current.verified = false;
        current.verifiedAt = null;
      }
    }
    if ('active' in body) current.active = parseBooleanInput(body.active);
    current.updatedAt = nowIso();
    return current;
  });
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}

export async function updateProductImage(id, file) {
  const saved = await persistSafeImage(file);
  if (!saved) throw new Error('Envie uma imagem válida.');
  const updated = await casProduct(id, p => ({ ...p, mediaKey: saved.mediaKey, imageMime: saved.imageMime, updatedAt: nowIso() }));
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}

export async function confirmProduct(id) {
  const updated = await casProduct(id, p => {
    if (!p.shopeeUrl) throw new Error('Produto sem link específico da Shopee.');
    return {
      ...p,
      price: p.price || p.observedPrice || '', active: true, verified: true, verifiedAt: nowIso(), updatedAt: nowIso()
    };
  });
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}

export async function deleteProduct(id) {
  const p = await getProduct(id);
  if (!p) return false;
  await productsStore().delete(`product/${id}`);
  // Mantemos a mídia: posts históricos podem referenciá-la. Limpeza é feita por rotina separada futura.
  return { ok: true, mediaPreserved: Boolean(p.mediaKey) };
}

function openAIClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Configure OPENAI_API_KEY no Netlify.');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 24000, maxRetries: 0 });
}

async function consumeAiBudget(kind) {
  const date = DateTime.now().setZone(TIMEZONE).toISODate();
  const limits = {
    copy: intEnv('AI_DAILY_COPY_LIMIT', 8),
    web: intEnv('AI_DAILY_WEB_LIMIT', 4),
    sync: intEnv('AI_DAILY_SYNC_LIMIT', 1)
  };
  const limit = limits[kind] ?? 4;
  return mutateSystemJson(`usage/${date}`, { date, copy: 0, web: 0, sync: 0, failures: 0 }, usage => {
    usage[kind] = Number(usage[kind] || 0) + 1;
    if (usage[kind] > limit) {
      const e = new Error(`Limite diário de IA atingido para ${kind} (${limit}).`);
      e.status = 429;
      throw e;
    }
    usage.updatedAt = nowIso();
    return usage;
  });
}

async function markAiFailure() {
  const date = DateTime.now().setZone(TIMEZONE).toISODate();
  await mutateSystemJson(`usage/${date}`, { date, copy: 0, web: 0, sync: 0, failures: 0 }, usage => {
    usage.failures = Number(usage.failures || 0) + 1;
    usage.updatedAt = nowIso();
    return usage;
  }).catch(() => {});
}

async function aiResponse({ kind = 'copy', model, input, tools }) {
  await consumeAiBudget(kind);
  try {
    return await openAIClient().responses.create({ model, input, ...(tools ? { tools } : {}), store: false });
  } catch (err) {
    await markAiFailure();
    throw err;
  }
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('A resposta da IA não veio em JSON válido.');
}

function memoryLine(p) {
  const first = String(p.message || '').split('\n').find(Boolean)?.slice(0, 100) || '';
  return `[${p.plannerType || p.origin || 'post'}] ${p.topic || p.productName || 'institucional'} :: ${first}`;
}

async function compactMemory(limit = 20) {
  const rows = (await listRecentPosts(80)).filter(p => p.status === 'published').slice(0, limit);
  return rows.map(memoryLine).join('\n');
}

async function performanceDigest(limit = 6) {
  const rows = (await listRecentPosts(80)).filter(p => p.status === 'published' && p.performance?.score != null)
    .sort((a, b) => Number(b.performance.score || 0) - Number(a.performance.score || 0)).slice(0, limit);
  if (!rows.length) return 'Ainda sem histórico suficiente de performance.';
  return rows.map(p => `${p.plannerType || 'post'} | ${p.topic || p.productName || 'tema'} | score ${p.performance.score}`).join('\n');
}

async function catalogDigest(limit = 14) {
  const rows = (await listProducts()).filter(p => p.active && p.verified).slice(0, limit);
  return rows.map(p => `${p.name}${p.category ? ` [${p.category}]` : ''}`).join(', ');
}

function salePrompt(product, memory) {
  return `Você é copywriter da Animaca Geek. Crie UM texto de Facebook para vender o produto abaixo.\nProduto: ${product.name}\nCategoria: ${product.category || 'não informada'}\nPreço: ${product.price || 'não informar'}\nDescrição factual: ${product.description || 'sem descrição adicional'}\n\nRegras:\n- Português do Brasil, humano e direto.\n- Gancho forte na primeira linha.\n- Não invente estoque, prazo, frete, desconto, material, avaliação ou benefício não informado.\n- NÃO inclua URL: o sistema acrescentará o link oficial da Shopee depois.\n- CTA para conhecer/comprar o produto, sem urgência falsa.\n- 3 a 5 hashtags relevantes.\n- Evite repetir os padrões recentes abaixo.\n- Retorne somente a copy final.\n\nMemória recente:\n${memory || 'sem posts recentes'}`;
}

function growthPrompt(memory, catalog, performance) {
  return `Você é estrategista de crescimento orgânico da Animaca Geek no Facebook. Crie UM post que aumente a chance de comentários, compartilhamentos e seguidores de forma natural.\n\nContexto de catálogo: ${catalog || 'personalizados e cultura geek'}\nO que já funcionou melhor:\n${performance}\n\nRegras:\n- Português do Brasil.\n- Uma única ideia simples.\n- Sem link de venda.\n- Pode usar nostalgia, escolha, fandom, games, anime, filmes, presentes e colecionismo.\n- Não use bait artificial do tipo “comente SIM”.\n- Termine com uma pergunta específica e fácil de responder.\n- 2 a 4 hashtags.\n- Não invente fatos ou tendências.\n- Retorne JSON puro: {"topic":"tema curto","message":"texto final"}.\n\nMemória recente para evitar repetição:\n${memory || 'sem posts recentes'}`;
}

export async function generateSaleCaption(product) {
  if (!product?.shopeeUrl) throw new Error('O produto precisa ter link específico da Shopee.');
  const response = await aiResponse({
    kind: 'copy',
    model: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini',
    input: salePrompt(product, await compactMemory())
  });
  const message = response.output_text?.trim();
  if (!message) throw new Error('A IA não retornou a legenda de venda.');
  return { message, topic: product.name };
}

export async function generateGrowthPost() {
  const response = await aiResponse({
    kind: 'copy',
    model: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini',
    input: growthPrompt(await compactMemory(), await catalogDigest(), await performanceDigest())
  });
  const parsed = extractJson(response.output_text);
  const message = String(parsed.message || '').trim();
  if (!message) throw new Error('A IA não retornou o post de crescimento.');
  return { message, topic: String(parsed.topic || 'crescimento geek').slice(0, 100) };
}

export async function generateHypePost() {
  const prompt = `Pesquise na web AGORA e encontre UM assunto dos últimos 3 dias com forte afinidade ao público geek brasileiro: anime, mangá, games, filmes/séries, trailers, lançamentos, eventos ou fandoms.\n\nCrie um post curto para a Animaca Geek aproveitar a conversa do momento, sem fingir que a loja vende um produto relacionado.\n\nRegras:\n- Confirme que é recente; se houver dúvida, escolha outro.\n- Evite política, tragédias, crimes, morte, boatos, conteúdo adulto e polêmicas sensíveis.\n- Não invente data, anúncio ou fato.\n- Não copie manchetes.\n- Não coloque links externos.\n- Termine com pergunta específica.\n- 2 a 4 hashtags.\n- Retorne JSON puro: {"topic":"assunto específico","confidence":0.0,"message":"texto final"}.\n- confidence deve refletir a segurança de que o assunto é realmente recente e adequado.\n\nMemória recente para não repetir:\n${await compactMemory() || 'sem posts recentes'}`;
  const response = await aiResponse({
    kind: 'web',
    model: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5',
    tools: [{ type: 'web_search' }], input: prompt
  });
  const parsed = extractJson(response.output_text);
  const message = String(parsed.message || '').trim();
  if (!message) throw new Error('A IA não encontrou um hype adequado agora.');
  return {
    message,
    topic: String(parsed.topic || 'hype geek').slice(0, 120),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)))
  };
}

export async function syncShopeeCatalog({ force = false } = {}) {
  const last = await systemStore().get('shopee-last-sync', { type: 'json', consistency: 'strong' }).catch(() => null);
  const minHours = intEnv('SHOPEE_SYNC_MIN_HOURS', 20);
  if (!force && last?.checkedAt && Date.now() - Date.parse(last.checkedAt) < minHours * 3600_000) {
    const e = new Error(`A loja já foi sincronizada recentemente. Aguarde ${minHours}h entre buscas para economizar API.`);
    e.status = 429;
    throw e;
  }
  const prompt = `Use busca web para inspecionar SOMENTE a loja Shopee ${SHOPEE_STORE_URL}. Localize produtos reais visíveis dessa loja e links individuais.\nRetorne JSON puro no formato {"products":[{"name":"...","price":"R$ ...","url":"https://shopee.com.br/...","confidence":0.0}]}.\nMáximo 30. Não invente item, preço nem URL. Itens novos serão enviados para revisão humana, então prefira precisão a quantidade.`;
  const response = await aiResponse({
    kind: 'sync', model: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5',
    tools: [{ type: 'web_search' }], input: prompt
  });
  const parsed = extractJson(response.output_text);
  const incoming = Array.isArray(parsed.products) ? parsed.products : [];
  if (!incoming.length) throw new Error('Nenhum candidato com link individual foi encontrado.');
  const existing = await listProducts();
  const byUrl = new Map(existing.filter(p => p.shopeeUrl).map(p => [p.shopeeUrl, p]));
  const now = nowIso();
  let created = 0, updated = 0, ignored = 0;
  const samples = [];
  for (const item of incoming.slice(0, 30)) {
    try {
      const name = String(item.name || '').trim();
      const url = await normalizeShopeeUrl(item.url);
      const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0)));
      if (!name || !url || confidence < 0.55) { ignored++; continue; }
      const old = byUrl.get(url);
      if (old) {
        await casProduct(old.id, p => ({
          ...p,
          observedPrice: String(item.price || '').trim(), lastSyncSeenAt: now,
          syncConfidence: confidence, updatedAt: now
        }));
        updated++;
      } else {
        const p = {
          id: uuid(), name, category: 'Shopee', price: '', observedPrice: String(item.price || '').trim(),
          description: 'Candidato encontrado na loja pública da Shopee. Confirme antes de usar em automação.',
          imageUrl: '', shopeeUrl: url, mediaKey: '', imageMime: '', active: false, verified: false, verifiedAt: null,
          source: 'shopee_sync', syncConfidence: confidence, lastSyncSeenAt: now, lastPostedAt: null, performanceScore: 0,
          createdAt: now, updatedAt: null
        };
        const r = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
        if (r.modified) created++; else ignored++;
      }
      if (samples.length < 5) samples.push({ name, url, confidence });
    } catch { ignored++; }
  }
  const result = { checkedAt: now, created, updated, ignored, found: incoming.length, storeUrl: SHOPEE_STORE_URL };
  await systemStore().setJSON('shopee-last-sync', result);
  await audit('shopee_sync', result);
  return { ...result, samples };
}

function xmlEsc(s) {
  return String(s || '').replace(/[<>&'\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function wrapText(text, max = 28, maxLines = 4) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) { lines.push(line); line = word; }
    else line = next;
    if (lines.length >= maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.slice(0, maxLines);
}

async function productImageBuffer(product) {
  if (product?.mediaKey) {
    const blob = await mediaStore().get(product.mediaKey, { type: 'blob', consistency: 'strong' });
    if (blob) return Buffer.from(await blob.arrayBuffer());
  }
  if (product?.imageUrl) {
    try {
      const { response } = await fetchPublicHttps(product.imageUrl, { headers: { accept: 'image/*' }, timeout: 6500 });
      if (!response.ok) return null;
      const buf = await readResponseLimited(response);
      const detected = await fileTypeFromBuffer(buf);
      if (detected && ['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) return buf;
    } catch (err) { console.warn('[remote-image]', err.message); }
  }
  return null;
}

function approxTextWidth(text, fontSize) {
  return [...String(text || '')].reduce((sum, ch) => sum + fontSize * (/[MW@#%]/.test(ch) ? .88 : /[ilI1.,' ]/.test(ch) ? .3 : .56), 0);
}

function wrapTextPx(text, maxWidth, fontSize, maxLines = 4) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && approxTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines - 1) break;
    } else line = candidate;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(' ').length > lines.join(' ').length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[.…]*$/, '') + '…';
  }
  return lines;
}

function creativeVariant(seed) {
  return crypto.createHash('sha256').update(String(seed || '')).digest()[0] % 6;
}

function svgLines(lines, { x, y, size, gap, color = '#0b111b', weight = 800, anchor = 'start' }) {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * gap}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${xmlEsc(line)}</text>`).join('');
}

async function createCreative({ type, message, topic, product, salt = '' }) {
  const seed = `${type}|${topic || product?.name || ''}|${DateTime.now().setZone(TIMEZONE).toISODate()}|${salt}`;
  const variant = creativeVariant(seed);
  const isSale = type === 'sale';
  const accent = type === 'hype' ? '#7c3aed' : type === 'growth' ? '#2563eb' : '#00b84a';
  const soft = type === 'hype' ? '#f5f0ff' : type === 'growth' ? '#eef5ff' : '#effff4';
  const headline = isSale ? (product?.name || 'Produto Animaca Geek') : (topic || (type === 'hype' ? 'Hype Geek' : 'Bora conversar?'));
  const firstLine = String(message || '').split('\n').find(Boolean) || '';
  const sub = isSale ? (product?.price || 'Disponível na Shopee') : firstLine;
  const image = isSale ? await productImageBuffer(product) : null;
  const base = sharp({ create: { width: 1080, height: 1080, channels: 4, background: '#ffffff' } });
  const composites = [];

  const decorations = variant % 3 === 0
    ? `<circle cx="970" cy="110" r="180" fill="${soft}"/><circle cx="80" cy="980" r="210" fill="${soft}"/>`
    : variant % 3 === 1
      ? `<rect x="0" y="0" width="1080" height="220" fill="${soft}"/><circle cx="1020" cy="860" r="230" fill="${soft}"/>`
      : `<path d="M0 0 H1080 V180 C760 310 360 40 0 220Z" fill="${soft}"/><path d="M1080 1080 H0 V930 C340 800 750 1060 1080 890Z" fill="${soft}"/>`;
  const bg = `<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="1080" fill="#fff"/>${decorations}<rect x="54" y="54" width="972" height="972" rx="38" fill="none" stroke="#e5e7eb" stroke-width="2"/></svg>`;
  composites.push({ input: Buffer.from(bg), left: 0, top: 0 });

  let titleX = 92, titleY = 650, titleWidth = 896, titleSize = 62, align = 'start';
  if (isSale && image) {
    if (variant % 3 === 0) {
      const photo = await sharp(image).rotate().resize(860, 560, { fit: 'contain', background: '#ffffff' }).webp({ quality: 92 }).toBuffer();
      composites.push({ input: photo, left: 110, top: 120 });
      titleY = 790; titleWidth = 850; titleSize = 55;
    } else if (variant % 3 === 1) {
      const photo = await sharp(image).rotate().resize(505, 760, { fit: 'contain', background: '#ffffff' }).webp({ quality: 92 }).toBuffer();
      composites.push({ input: photo, left: 520, top: 180 });
      titleX = 90; titleY = 410; titleWidth = 390; titleSize = 52;
    } else {
      const photo = await sharp(image).rotate().resize(505, 760, { fit: 'contain', background: '#ffffff' }).webp({ quality: 92 }).toBuffer();
      composites.push({ input: photo, left: 55, top: 180 });
      titleX = 600; titleY = 410; titleWidth = 390; titleSize = 52;
    }
  } else {
    titleY = variant % 2 ? 420 : 360;
    titleSize = variant % 2 ? 70 : 76;
    titleWidth = 860;
  }

  const titleLines = wrapTextPx(headline, titleWidth, titleSize, isSale ? 4 : 5);
  const subSize = isSale ? 34 : 32;
  const subLines = wrapTextPx(sub, titleWidth, subSize, isSale ? 2 : 3);
  const label = isSale ? 'ANIMACA GEEK • SHOPEE' : type === 'hype' ? 'ANIMACA GEEK • EM ALTA' : 'ANIMACA GEEK • COMUNIDADE';
  const footer = isSale ? 'Veja o link do produto na legenda' : type === 'hype' ? 'O que você achou?' : 'Sua opinião faz parte da conversa';
  const textSvg = `<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect x="92" y="88" width="${Math.min(650, 40 + approxTextWidth(label, 25))}" height="50" rx="25" fill="${accent}"/>
    <text x="116" y="121" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="800" fill="#ffffff">${xmlEsc(label)}</text>
    ${svgLines(titleLines,{x:titleX,y:titleY,size:titleSize,gap:Math.round(titleSize*1.12),color:'#0b111b',weight:900,anchor:align})}
    ${svgLines(subLines,{x:titleX,y:titleY + titleLines.length*Math.round(titleSize*1.12)+42,size:subSize,gap:44,color:'#475569',weight:600,anchor:align})}
    <rect x="92" y="955" width="12" height="12" rx="6" fill="${accent}"/><text x="122" y="970" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="#334155">${xmlEsc(footer)}</text>
  </svg>`;
  composites.push({ input: Buffer.from(textSvg), left: 0, top: 0 });
  const output = await base.composite(composites).webp({ quality: 92 }).toBuffer();
  const saved = await saveGeneratedMedia(output, { mime: 'image/webp', source: 'creative-engine-v2', type, variant });
  return { ...saved, variant };
}

export function textSimilarity(a, b) {
  const tokens = s => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length > 3));
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

async function qualityGate(post, product = null) {
  const blockers = [], warnings = [];
  let score = 100;
  const msg = String(post.message || '').trim();
  if (msg.length < 45) { score -= 20; warnings.push('copy muito curta'); }
  if (msg.length > 1800) { score -= 15; warnings.push('copy muito longa'); }
  if (/\b(lorem ipsum|placeholder|insira aqui|http:\/\/|example\.com)\b/i.test(msg)) blockers.push('placeholder ou URL insegura na copy');
  const recent = (await listRecentPosts(35)).filter(p => p.status === 'published');
  const maxSimilarity = recent.reduce((m, p) => Math.max(m, textSimilarity(msg, p.message)), 0);
  if (maxSimilarity >= 0.82) blockers.push('copy muito parecida com publicação recente');
  else if (maxSimilarity >= 0.65) { score -= 15; warnings.push('estrutura semelhante a post recente'); }

  if (post.plannerType === 'sale') {
    if (!product) blockers.push('produto não encontrado');
    if (product && !product.active) blockers.push('produto inativo');
    if (product && !product.verified) blockers.push('produto ainda não confirmado');
    if (!post.shopeeUrl || post.shopeeUrl !== product?.shopeeUrl) blockers.push('link Shopee não confere com o produto atual');
    if (!product?.mediaKey && !product?.imageUrl) blockers.push('produto sem foto real cadastrada');
  }
  if (post.plannerType === 'hype') {
    if (Number(post.hypeConfidence ?? 0) < 0.65) blockers.push('confiança insuficiente no hype');
    if (/\b(eleição|presidente|governo|guerra|morreu|morte|assassin|crime|tragédia|tragico|tragico|acidente fatal)\b/i.test(`${post.topic || ''} ${msg}`)) blockers.push('tema sensível bloqueado');
  }
  if (post.plannerType === 'growth' && !msg.includes('?')) { score -= 10; warnings.push('post de crescimento sem pergunta clara'); }
  if (post.origin === 'planner' && !post.mediaKey && !post.imageUrl) blockers.push('post automático sem arte visual');
  score = Math.max(0, score);
  return { score, blockers, warnings, maxSimilarity: Number(maxSimilarity.toFixed(3)), canAutoApprove: blockers.length === 0 && score >= intEnv('AUTO_APPROVE_MIN_SCORE', 85) };
}

async function insertPost({ product = null, displayName = '', message, imageUrl = '', mediaKey = '', imageMime = '', scheduledAt = null, origin = 'manual', plannerType = null, status = 'draft', topic = '', hypeConfidence = null, dailyDate = null, generatedVisual = false }) {
  const clean = String(message || '').trim();
  if (!clean) throw new Error('Legenda é obrigatória.');
  const now = nowIso();
  const p = {
    id: uuid(), productId: product?.id || null, productName: product?.name || displayName || '', message: clean,
    imageUrl: imageUrl || '', mediaKey: mediaKey || '', imageMime: imageMime || '', shopeeUrl: product?.shopeeUrl || '',
    status, scheduledAt, createdAt: now, updatedAt: null, publishedAt: null, metaPostId: null,
    error: null, errorCode: null, errorSubcode: null, lastAttemptAt: null, publishToken: null, publishLockAt: null,
    origin, plannerType, topic, hypeConfidence, dailyDate, quality: null, performance: null, generatedVisual
  };
  p.quality = await qualityGate(p, product);
  if (boolEnv('AUTO_APPROVE_PLANNER') && origin === 'planner' && p.quality.canAutoApprove) p.status = 'approved';
  const result = await postsStore().setJSON(`post/${p.id}`, p, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível criar o post.');
  await indexPost(p, { isNew: true });
  return postView(p);
}

async function buildPostForType(type, scheduledAt, dailyDate, origin = 'planner') {
  const spec = typeSpec(type);
  if (type === 'sale') {
    const product = await chooseSaleProduct();
    const generated = await generateSaleCaption(product);
    const creative = await createCreative({ type, message: generated.message, topic: generated.topic, product }).catch(err => { console.error('[creative-sale]', err); return null; });
    return insertPost({ product, message: generated.message, scheduledAt, origin, plannerType: type, topic: generated.topic, dailyDate, mediaKey: creative?.mediaKey || product.mediaKey || '', imageMime: creative?.imageMime || product.imageMime || '', imageUrl: creative ? '' : product.imageUrl || '', generatedVisual: Boolean(creative) });
  }
  if (type === 'hype') {
    const generated = await generateHypePost();
    const creative = await createCreative({ type, message: generated.message, topic: generated.topic }).catch(err => { console.error('[creative-hype]', err); return null; });
    return insertPost({ displayName: spec.label, message: generated.message, scheduledAt, origin, plannerType: type, topic: generated.topic, hypeConfidence: generated.confidence, dailyDate, mediaKey: creative?.mediaKey || '', imageMime: creative?.imageMime || '', generatedVisual: Boolean(creative) });
  }
  const generated = await generateGrowthPost();
  const creative = await createCreative({ type, message: generated.message, topic: generated.topic }).catch(err => { console.error('[creative-growth]', err); return null; });
  return insertPost({ displayName: spec.label, message: generated.message, scheduledAt, origin, plannerType: type, topic: generated.topic, dailyDate, mediaKey: creative?.mediaKey || '', imageMime: creative?.imageMime || '', generatedVisual: Boolean(creative) });
}

export async function generateManualSale(productId) {
  const product = await getProduct(productId);
  if (!product || !product.active || !product.verified) throw new Error('Produto precisa estar ativo e confirmado.');
  const generated = await generateSaleCaption(product);
  const creative = await createCreative({ type: 'sale', message: generated.message, topic: generated.topic, product }).catch(() => null);
  return insertPost({ product, message: generated.message, origin: 'manual', plannerType: 'sale', topic: generated.topic, mediaKey: creative?.mediaKey || product.mediaKey || '', imageMime: creative?.imageMime || product.imageMime || '', imageUrl: creative ? '' : product.imageUrl || '', generatedVisual: Boolean(creative) });
}

export async function generateManualType(type, productId = null) {
  if (type === 'sale') return generateManualSale(productId);
  if (!['hype', 'growth'].includes(type)) throw new Error('Tipo de teste inválido.');
  const generated = type === 'hype' ? await generateHypePost() : await generateGrowthPost();
  const creative = await createCreative({ type, message: generated.message, topic: generated.topic, salt: uuid() });
  return insertPost({
    displayName: type === 'hype' ? 'Hype do momento' : 'Crescimento',
    message: generated.message, origin: 'manual', plannerType: type, topic: generated.topic,
    hypeConfidence: generated.confidence ?? null, mediaKey: creative.mediaKey, imageMime: creative.imageMime, generatedVisual: true
  });
}

export async function regeneratePostCreative(id, mode = 'template') {
  const current = await getPost(id);
  if (!current) throw new Error('Post não encontrado.');
  if (['published', 'publishing'].includes(current.status)) throw new Error('Não é possível trocar a arte de um post já publicado/em publicação.');
  const product = current.productId ? await getProduct(current.productId) : null;
  let patch;
  if (mode === 'original') {
    if (!product || (!product.mediaKey && !product.imageUrl)) throw new Error('Este post não possui foto original de produto disponível.');
    patch = { mediaKey: product.mediaKey || '', imageMime: product.imageMime || '', imageUrl: product.mediaKey ? '' : product.imageUrl || '', generatedVisual: false };
  } else {
    const creative = await createCreative({ type: current.plannerType || 'growth', message: current.message, topic: current.topic, product, salt: uuid() });
    patch = { mediaKey: creative.mediaKey, imageMime: creative.imageMime, imageUrl: '', generatedVisual: true, creativeVariant: creative.variant };
  }
  const updated = await casPost(id, async row => {
    Object.assign(row, patch);
    if (row.status === 'approved') row.status = 'draft';
    row.quality = await qualityGate(row, product);
    row.updatedAt = nowIso();
    return row;
  });
  return updated;
}

export async function patchPost(id, body) {
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


export async function chooseSaleProduct() {
  const products = (await listProducts()).filter(p => p.active && p.verified && p.shopeeUrl && (p.mediaKey || p.imageUrl));
  if (!products.length) throw new Error('Nenhum produto pronto para venda: precisa estar ativo, confirmado, com link Shopee e foto real.');
  const recent = await listRecentPosts(70);
  const recentIds = new Set(recent.filter(p => p.status === 'published' && p.plannerType === 'sale' && p.productId).slice(0, 5).map(p => p.productId));
  products.sort((a, b) => {
    const ar = recentIds.has(a.id) ? 1 : 0, br = recentIds.has(b.id) ? 1 : 0;
    if (ar !== br) return ar - br;
    const perf = Number(b.performanceScore || 0) - Number(a.performanceScore || 0);
    if (Math.abs(perf) > 0.01) return perf;
    return (a.lastPostedAt ? Date.parse(a.lastPostedAt) : 0) - (b.lastPostedAt ? Date.parse(b.lastPostedAt) : 0);
  });
  return products[0];
}

function planKey(date) { return `daily-plan/${date}`; }

async function ensurePlan(dateRaw) {
  const date = String(dateRaw || DateTime.now().setZone(TIMEZONE).toISODate());
  const d = DateTime.fromISO(date, { zone: TIMEZONE });
  if (!d.isValid) throw new Error('Data do plano inválida.');
  const slots = plannerSlots();
  const initial = {
    date, timezone: TIMEZONE, createdAt: nowIso(), updatedAt: nowIso(),
    slots: {
      sale: { type: 'sale', scheduledAt: localToUtc(`${date}T${slots[0]}`), state: 'planned', attempts: 0, postId: null },
      hype: { type: 'hype', scheduledAt: localToUtc(`${date}T${slots[1]}`), state: 'planned', attempts: 0, postId: null },
      growth: { type: 'growth', scheduledAt: localToUtc(`${date}T${slots[2]}`), state: 'planned', attempts: 0, postId: null }
    }
  };
  const store = systemStore();
  const existing = await store.get(planKey(date), { type: 'json', consistency: 'strong' });
  if (existing) return existing;
  const result = await store.setJSON(planKey(date), initial, { onlyIfNew: true });
  if (result.modified) return initial;
  return await store.get(planKey(date), { type: 'json', consistency: 'strong' }) || initial;
}

async function markPlanSlot(date, type, patch) {
  return mutateSystemJson(planKey(date), await ensurePlan(date), plan => {
    plan.slots ||= {};
    plan.slots[type] = { ...(plan.slots[type] || {}), ...patch };
    plan.updatedAt = nowIso();
    return plan;
  });
}

export async function reserveDailyPlan(dateRaw) {
  const plan = await ensurePlan(dateRaw);
  await audit('plan_reserved', { date: plan.date });
  return plan;
}

async function claimPlanSlot(date, type) {
  const now = DateTime.now().setZone(TIMEZONE);
  await ensurePlan(date);
  let claimed = false;
  let snapshot = null;
  const plan = await mutateSystemJson(planKey(date), await ensurePlan(date), p => {
    const slot = p.slots?.[type];
    if (!slot) throw new Error('Slot não encontrado.');
    snapshot = structuredClone(slot);
    const scheduled = DateTime.fromISO(slot.scheduledAt, { zone: 'utc' }).setZone(TIMEZONE);
    if (now >= scheduled.minus({ minutes: 5 }) && !['ready','published','cancelled'].includes(slot.state)) {
      slot.state = 'expired'; slot.lastError = 'Janela de preparação já passou.'; p.updatedAt = nowIso(); return p;
    }
    if (['ready','published','cancelled','expired'].includes(slot.state)) return p;
    if (slot.state === 'creating' && Date.now() - Date.parse(slot.lockedAt || 0) < 8 * 60_000) return p;
    if (Number(slot.attempts || 0) >= SLOT_MAX_ATTEMPTS) { slot.state = 'failed'; return p; }
    if (slot.nextRetryAt && Date.now() < Date.parse(slot.nextRetryAt)) return p;
    slot.state = 'creating'; slot.attempts = Number(slot.attempts || 0) + 1; slot.lockedAt = nowIso(); slot.lastError = null;
    p.updatedAt = nowIso(); claimed = true; snapshot = structuredClone(slot); return p;
  });
  return { claimed, slot: plan.slots[type], previous: snapshot };
}

export async function prepareDailySlot(type, dateRaw = null) {
  if (!boolEnv('AUTO_PLAN', false)) return { autoPlan: false, type };
  const date = String(dateRaw || DateTime.now().setZone(TIMEZONE).toISODate());
  const claim = await claimPlanSlot(date, type);
  if (!claim.claimed) return { type, date, skipped: true, state: claim.slot?.state || 'unknown', postId: claim.slot?.postId || null };
  const scheduledAt = claim.slot.scheduledAt;
  try {
    const post = await buildPostForType(type, scheduledAt, date, 'planner');
    await markPlanSlot(date, type, { state: 'ready', postId: post.id, qualityScore: post.quality?.score ?? null, lockedAt: null, nextRetryAt: null });
    await audit('slot_ready', { date, type, postId: post.id, quality: post.quality });
    return { type, date, created: true, post };
  } catch (err) {
    const retryAt = DateTime.now().setZone(TIMEZONE).plus({ minutes: SLOT_RETRY_MINUTES }).toUTC().toISO({ suppressMilliseconds: true });
    const plan = await ensurePlan(date);
    const attempts = Number(plan.slots?.[type]?.attempts || claim.slot?.attempts || 1);
    await markPlanSlot(date, type, { state: attempts >= SLOT_MAX_ATTEMPTS ? 'failed' : 'error', lastError: err.message, nextRetryAt: retryAt, lockedAt: null });
    await audit('slot_error', { date, type, error: err.message, attempts });
    throw err;
  }
}

export async function generatePlan(dateRaw) {
  // Compatibilidade com a v0.4: agora este botão apenas reserva o plano; a IA gera perto de cada horário.
  return reserveDailyPlan(dateRaw);
}

async function validateBeforePublish(post) {
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

async function graphGet(endpoint, params = {}, token = process.env.META_PAGE_ACCESS_TOKEN) {
  const version = process.env.META_GRAPH_VERSION || 'v26.0';
  const url = new URL(`https://graph.facebook.com/${version}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const response = await fetch(url, { headers: { accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) { const err = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`); err.code = json?.error?.code; err.subcode = json?.error?.error_subcode; throw err; }
  return json;
}

export async function validateMetaConnection(force = false) {
  if (!process.env.META_PAGE_ID || !process.env.META_PAGE_ACCESS_TOKEN) return { configured: false, valid: false, reason: 'META_PAGE_ID ou META_PAGE_ACCESS_TOKEN ausente.' };
  const cache = systemStore();
  if (!force) {
    const cached = await cache.get('meta-validation', { type: 'json', consistency: 'strong' });
    if (cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < 10 * 60_000) return cached;
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
    value = { configured: true, valid: matchesPage, pageId: identity.id, pageName: identity.name, matchesPage, tasks, canCreateContent, taskValidationError, checkedAt: nowIso(), reason: matchesPage ? null : 'O token respondeu por uma identidade diferente do META_PAGE_ID.' };
  } catch (err) {
    value = { configured: true, valid: false, reason: err.message, code: err.code || null, subcode: err.subcode || null, checkedAt: nowIso() };
  }
  await cache.setJSON('meta-validation', value);
  return value;
}

async function graphPost(endpoint, body) {
  const version = process.env.META_GRAPH_VERSION || 'v26.0';
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) throw new Error('Credenciais da Meta não configuradas.');
  const url = `https://graph.facebook.com/${version}/${pageId}/${endpoint}`;
  let response;
  try {
    response = await fetch(url, { method: 'POST', body, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    const e = new Error(`Falha de rede ao chamar a Meta: ${err.message}`); e.ambiguous = true; throw e;
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`); e.code = json?.error?.code; e.subcode = json?.error?.error_subcode; if (response.status >= 500 || response.status === 408) e.ambiguous = true; throw e; }
  return json;
}

async function publishPost(post) {
  await validateBeforePublish(post);
  const message = buildFinalMessage(post);
  if (post.mediaKey) {
    const entry = await mediaStore().get(post.mediaKey, { type: 'blob', consistency: 'strong' });
    if (entry) {
      const form = new FormData();
      form.append('caption', message);
      form.append('source', entry, `${post.mediaKey}.webp`);
      return graphPost('photos', form);
    }
  }
  if (post.imageUrl) return graphPost('photos', new URLSearchParams({ url: post.imageUrl, caption: message }));
  return graphPost('feed', new URLSearchParams({ message }));
}

async function claimPost(id) {
  const store = postsStore();
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await getPostEntry(id);
    if (!entry) throw new Error('Post não encontrado.');
    const row = entry.post;
    if (row.status === 'published') return { already: true, post: postView(row) };
    if (row.status === 'publishing') {
      const age = Date.now() - Date.parse(row.publishLockAt || 0);
      if (age < PUBLISH_LOCK_MS) { const e = new Error('Este post já está em processo de publicação.'); e.status = 409; throw e; }
      const review = { ...row, status: 'needs_review', error: 'A tentativa anterior ficou sem confirmação final. Verifique o Facebook antes de qualquer nova publicação.', publishToken: null, publishLockAt: null, updatedAt: nowIso() };
      const moved = await store.setJSON(`post/${id}`, review, { onlyIfMatch: entry.etag });
      if (moved.modified) await indexPost(review).catch(() => {});
      const e = new Error('Publicação anterior com resultado incerto. O post foi enviado para revisão manual para evitar duplicação.'); e.status = 409; e.ambiguous = true; throw e;
    }
    if (row.status !== 'approved') { const e = new Error('Apenas posts aprovados podem ser publicados.'); e.status = 409; throw e; }
    const token = uuid(), now = nowIso();
    const next = { ...row, status: 'publishing', publishToken: token, publishLockAt: now, lastAttemptAt: now, error: null, errorCode: null, errorSubcode: null, updatedAt: now };
    const result = await store.setJSON(`post/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) { await indexPost(next).catch(() => {}); return { already: false, token, post: postView(next) }; }
  }
  const e = new Error('Outra execução provavelmente já assumiu este post.'); e.status = 409; throw e;
}

export async function publishById(id) {
  const claim = await claimPost(id);
  if (claim.already) return claim.post;
  let metaAccepted = false;
  try {
    const result = await publishPost(claim.post);
    metaAccepted = true;
    const now = nowIso();
    const updated = await casPost(id, current => {
      if (current.publishToken !== claim.token) throw new Error('A Meta aceitou o post, mas o estado local mudou. Revisão manual necessária.');
      return { ...current, status: 'published', publishedAt: now, metaPostId: result.post_id || result.id || null, error: null, errorCode: null, errorSubcode: null, publishToken: null, publishLockAt: null, updatedAt: now };
    });
    if (claim.post.productId) await casProduct(claim.post.productId, p => ({ ...p, lastPostedAt: now, updatedAt: now })).catch(() => {});
    if (updated.dailyDate && updated.plannerType) await markPlanSlot(updated.dailyDate, updated.plannerType, { state: 'published', postId: updated.id, publishedAt: now });
    await audit('published', { postId: id, plannerType: updated.plannerType, metaPostId: updated.metaPostId });
    return updated;
  } catch (err) {
    const state = (err.ambiguous || metaAccepted) ? 'needs_review' : 'error';
    await casPost(id, current => current.publishToken !== claim.token ? current : ({ ...current, status: state, error: err.message, errorCode: String(err.code || ''), errorSubcode: String(err.subcode || ''), publishToken: null, publishLockAt: null, updatedAt: nowIso() })).catch(() => {});
    await audit('publish_error', { postId: id, error: err.message, ambiguous: Boolean(err.ambiguous) });
    throw err;
  }
}

export async function publishDailySlot(type, dateRaw = null) {
  if (!boolEnv('AUTO_PUBLISH', false)) return { autoPublish: false, type };
  const date = String(dateRaw || DateTime.now().setZone(TIMEZONE).toISODate());
  const plan = await ensurePlan(date);
  const slot = plan.slots?.[type];
  if (!slot?.postId) return { type, date, skipped: true, reason: 'slot sem post preparado', state: slot?.state || 'planned' };
  const post = await getPost(slot.postId);
  if (!post) return { type, date, skipped: true, reason: 'post não encontrado' };
  if (post.status !== 'approved') return { type, date, skipped: true, reason: `post está ${post.status}`, postId: post.id };
  return { type, date, published: true, post: await publishById(post.id) };
}

export async function publishDuePosts(limit = 10) {
  // Compatibilidade manual. Usa apenas o índice recente, evitando scan histórico.
  if (!boolEnv('AUTO_PUBLISH', false)) return { autoPublish: false, attempted: 0, published: 0, errors: [] };
  const now = nowIso();
  const due = (await listRecentPosts(POST_INDEX_LIMIT)).filter(p => p.status === 'approved' && p.scheduledAt && p.scheduledAt <= now)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).slice(0, limit);
  let published = 0; const errors = [];
  for (const post of due) { try { await publishById(post.id); published++; } catch (err) { errors.push({ id: post.id, error: err.message }); } }
  return { autoPublish: true, attempted: due.length, published, errors };
}

async function recomputeProductPerformance(productId) {
  const samples = (await listRecentPosts(POST_INDEX_LIMIT))
    .filter(p => p.status === 'published' && p.productId === productId && Number.isFinite(Number(p.performance?.score)))
    .slice(0, 12);
  if (!samples.length) return null;
  const score = samples.reduce((sum, p) => sum + Number(p.performance.score || 0), 0) / samples.length;
  await casProduct(productId, p => ({ ...p, performanceScore: Number(score.toFixed(2)), performanceSamples: samples.length, performanceUpdatedAt: nowIso(), updatedAt: nowIso() })).catch(() => {});
  return score;
}

async function refreshPostPerformance(post) {
  if (!post?.metaPostId) return null;
  const data = await graphGet(post.metaPostId, { fields: 'reactions.limit(0).summary(true),comments.limit(0).summary(true),shares' });
  const reactions = Number(data?.reactions?.summary?.total_count || 0);
  const comments = Number(data?.comments?.summary?.total_count || 0);
  const shares = Number(data?.shares?.count || 0);
  const score = reactions + comments * 4 + shares * 6;
  const performance = { reactions, comments, shares, score, checkedAt: nowIso() };
  const updated = await casPost(post.id, p => ({ ...p, performance, updatedAt: nowIso() }));
  if (updated.productId) await recomputeProductPerformance(updated.productId);
  return performance;
}

export async function refreshRecentPerformance(limit = 6) {
  if (!process.env.META_PAGE_ACCESS_TOKEN) return { refreshed: 0, errors: ['Meta não configurada'] };
  const now = Date.now();
  const candidates = (await listRecentPosts(POST_INDEX_LIMIT))
    .filter(p => p.status === 'published' && p.metaPostId && p.publishedAt && now - Date.parse(p.publishedAt) >= 60 * 60_000 && now - Date.parse(p.publishedAt) <= 14 * 86400_000)
    .sort((a, b) => String(a.performance?.checkedAt || '').localeCompare(String(b.performance?.checkedAt || '')))
    .slice(0, limit);
  const results = await Promise.allSettled(candidates.map(refreshPostPerformance));
  const refreshed = results.filter(r => r.status === 'fulfilled').length;
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason?.message || 'erro');
  await audit('performance_refresh', { refreshed, errors: errors.length });
  return { refreshed, errors };
}

export function deriveHealthState(result) {
  if (result?.error) return 'error';
  if (result?.autoPlan === false || result?.autoPublish === false) return 'off';
  if (result?.skipped) return 'warning';
  return 'ok';
}

async function audit(type, data = {}) {
  const entry = { id: uuid(), type, at: nowIso(), data };
  await mutateSystemJson('audit-recent', { items: [] }, log => {
    log.items = [entry, ...(Array.isArray(log.items) ? log.items : [])].slice(0, 50);
    return log;
  }).catch(() => {});
  return entry;
}

export async function recordHealth(name, result) {
  return mutateSystemJson('health', {}, health => {
    const state = deriveHealthState(result);
    health[name] = { at: nowIso(), state, ok: state === 'ok', result };
    return health;
  });
}

export async function getDailyPlans() {
  const now = DateTime.now().setZone(TIMEZONE);
  const dates = [now.toISODate(), now.plus({ days: 1 }).toISODate()];
  const plans = await Promise.all(dates.map(d => systemStore().get(planKey(d), { type: 'json', consistency: 'strong' }).catch(() => null)));
  return plans.filter(Boolean);
}

export async function bootstrapSummary() {
  const today = DateTime.now().setZone(TIMEZONE).toISODate();
  const [products, posts, meta, sync, usage, auditLog, health, plans, idx] = await Promise.all([
    listProducts(), listRecentPosts(60), validateMetaConnection(false),
    systemStore().get('shopee-last-sync', { type: 'json', consistency: 'strong' }).catch(() => null),
    systemStore().get(`usage/${today}`, { type: 'json', consistency: 'strong' }).catch(() => null),
    systemStore().get('audit-recent', { type: 'json', consistency: 'strong' }).catch(() => null),
    systemStore().get('health', { type: 'json', consistency: 'strong' }).catch(() => null),
    getDailyPlans(), ensurePostIndex()
  ]);
  const pending = posts.filter(p => ['draft', 'approved', 'error', 'needs_review'].includes(p.status)).length;
  return {
    status: {
      openai: Boolean(process.env.OPENAI_API_KEY), autoPlan: boolEnv('AUTO_PLAN', false), autoApprovePlanner: boolEnv('AUTO_APPROVE_PLANNER', false),
      autoPublish: boolEnv('AUTO_PUBLISH', false), graphVersion: process.env.META_GRAPH_VERSION || 'v26.0', timezone: TIMEZONE,
      plannerSlots: plannerSlots(), meta,
      shopee: { storeUrl: SHOPEE_STORE_URL, lastSync: sync || null, linkedProducts: products.filter(p => p.shopeeUrl).length, verifiedProducts: products.filter(p => p.active && p.verified && p.shopeeUrl).length },
      counts: { products: products.length, posts: Number(idx.totalPosts || posts.length), pending }, usage: usage || { date: today, copy: 0, web: 0, sync: 0, failures: 0 },
      usageLimits: { copy: intEnv('AI_DAILY_COPY_LIMIT', 8), web: intEnv('AI_DAILY_WEB_LIMIT', 4), sync: intEnv('AI_DAILY_SYNC_LIMIT', 1) },
      models: { copy: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini', web: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5' }, version: '0.6.0'
    },
    data: { products, posts, plans, audit: auditLog?.items || [], health: health || {}, settings: { timezone: TIMEZONE, plannerSlots: plannerSlots(), storage: 'Netlify Blobs', strategy: PLAN_TYPES } }
  };
}

export async function cleanupOrphanMedia({ minAgeDays = 14, limit = 80 } = {}) {
  const [products, posts] = await Promise.all([listProducts(), listJson(postsStore, 'post/')]);
  const referenced = new Set([
    ...products.map(p => p.mediaKey).filter(Boolean),
    ...posts.map(p => p.mediaKey).filter(Boolean)
  ]);
  const { blobs } = await mediaStore().list();
  let checked = 0, deleted = 0;
  const cutoff = Date.now() - minAgeDays * 86400_000;
  for (const blob of blobs) {
    if (checked >= limit) break;
    if (referenced.has(blob.key)) continue;
    checked++;
    try {
      const entry = await mediaStore().getWithMetadata(blob.key, { type: 'blob', consistency: 'strong' });
      const created = Date.parse(entry?.metadata?.createdAt || 0);
      if (created && created < cutoff) { await mediaStore().delete(blob.key); deleted++; }
    } catch {}
  }
  const result = { checked, deleted, referenced: referenced.size, at: nowIso() };
  await audit('media_cleanup', result);
  return result;
}

export async function statusSummary() { return (await bootstrapSummary()).status; }
export async function dataSummary() { return (await bootstrapSummary()).data; }

export async function checkLoginRate(ip) {
  const key = `login/${crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex')}`;
  const store = systemStore(); const now = Date.now(); const windowMs = 15 * 60_000; const max = 5;
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (!entry) {
      const result = await store.setJSON(key, { first: now, count: 1 }, { onlyIfNew: true });
      if (result.modified) return true;
      continue;
    }
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
