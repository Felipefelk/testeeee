import { getStore } from '@netlify/blobs';
import OpenAI from 'openai';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { DateTime } from 'luxon';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';

export const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
export const SESSION_COOKIE = 'animaca_session';
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
  return slots.length ? slots : ['10:00', '15:00', '20:00'];
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

export function validateHttpsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') throw new Error();
    return u.toString();
  } catch {
    throw new Error('A URL da imagem precisa ser HTTPS válida.');
  }
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
  return { ...p, mediaUrl: p.mediaKey ? `/media/${encodeURIComponent(p.mediaKey)}` : '' };
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
  const output = await sharp(bytes, { failOn: 'error' })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  const key = uuid();
  const result = await mediaStore().set(key, new Blob([output], { type: 'image/webp' }), { metadata: { mime: 'image/webp', createdAt: new Date().toISOString() }, onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível salvar a imagem.');
  return { mediaKey: key, imageMime: 'image/webp' };
}

export async function getMedia(key) {
  if (!/^[a-f0-9-]{30,50}$/i.test(String(key || ''))) return null;
  return mediaStore().getWithMetadata(String(key), { type: 'blob', consistency: 'strong' });
}

export async function createProduct({ name, category = '', price = '', description = '', imageUrl = '', file = null }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Nome do produto é obrigatório.');
  const saved = await persistSafeImage(file);
  const now = new Date().toISOString();
  const p = {
    id: uuid(), name: cleanName, category: String(category || '').trim(), price: String(price || '').trim(),
    description: String(description || '').trim(), imageUrl: validateHttpsUrl(imageUrl), mediaKey: saved?.mediaKey || '',
    imageMime: saved?.imageMime || '', active: true, lastPostedAt: null, createdAt: now, updatedAt: null
  };
  const result = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível cadastrar o produto.');
  return productView(p);
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

async function recentPublishedText(limit = 12) {
  const rows = (await listPosts()).filter(p => p.status === 'published').sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))).slice(0, limit);
  return rows.map(p => `${p.productName || 'institucional'}: ${p.message}`).join('\n---\n');
}

function contentStrategy(product, recent, mode = 'product_sale') {
  const modeRule = {
    product_sale: 'Objetivo: vender o produto de forma direta, destacando apenas benefícios sustentados pelos dados fornecidos.',
    engagement: 'Objetivo: gerar comentário/interação com uma pergunta ou gancho geek, conectando naturalmente ao produto sem forçar venda.',
    showcase: 'Objetivo: mostrar personalização, presente ou uso do produto de forma visual e desejável, com CTA leve.',
    institutional: 'Objetivo: reforçar marca e relacionamento, sem inventar números, depoimentos ou fatos.'
  }[mode] || '';
  return `Você é o agente de conteúdo da Animaca Geek, marca brasileira de personalizados com linguagem humana, comercial e geek.\n\n${modeRule}\nProduto: ${product?.name || 'Nenhum produto específico'}\nCategoria: ${product?.category || 'não informada'}\nPreço: ${product?.price || 'não informar preço'}\nDescrição: ${product?.description || 'sem descrição adicional'}\n\nRegras:\n- Português do Brasil.\n- Comece com um gancho forte, sem parecer texto genérico de IA.\n- Parágrafos curtos.\n- CTA claro quando fizer sentido.\n- 3 a 6 hashtags relevantes no final.\n- NÃO invente características, estoque, prazo, frete, avaliações, números ou promoções.\n- Evite repetir estruturas dos posts recentes.\n- Retorne somente a legenda final.\n\nPosts recentes:\n${recent || 'Nenhum.'}`;
}

export async function generateCaption(product, mode) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Configure OPENAI_API_KEY no Netlify.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({ model: process.env.OPENAI_MODEL || 'gpt-5.6', input: contentStrategy(product, await recentPublishedText(), mode), store: false });
  const message = response.output_text?.trim();
  if (!message) throw new Error('A IA não retornou uma legenda.');
  return message;
}

export async function insertPost({ product = null, message, imageUrl = '', mediaKey = '', imageMime = '', scheduledAt = null, origin = 'manual', plannerType = null, status = 'draft' }) {
  const clean = String(message || '').trim();
  if (!clean) throw new Error('Legenda é obrigatória.');
  const now = new Date().toISOString();
  const p = {
    id: uuid(), productId: product?.id || null, productName: product?.name || '', message: clean,
    imageUrl: imageUrl || product?.imageUrl || '', mediaKey: mediaKey || product?.mediaKey || '', imageMime: imageMime || product?.imageMime || '',
    status, scheduledAt, createdAt: now, updatedAt: null, publishedAt: null, metaPostId: null, error: null,
    errorCode: null, errorSubcode: null, lastAttemptAt: null, publishToken: null, publishLockAt: null, origin, plannerType
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
    if ('message' in body) {
      const m = String(body.message || '').trim(); if (!m) throw new Error('Legenda não pode ficar vazia.'); current.message = m;
    }
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

export async function chooseProductsForPlan(count) {
  const products = (await listProducts()).filter(p => p.active);
  if (!products.length) throw new Error('Cadastre pelo menos um produto ativo antes de usar o Planner.');
  const posts = (await listPosts()).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const recentIds = new Set(posts.filter(p => p.productId).slice(0, 3).map(p => p.productId));
  products.sort((a, b) => {
    const ar = recentIds.has(a.id) ? 1 : 0, br = recentIds.has(b.id) ? 1 : 0;
    if (ar !== br) return ar - br;
    return (a.lastPostedAt ? Date.parse(a.lastPostedAt) : 0) - (b.lastPostedAt ? Date.parse(b.lastPostedAt) : 0);
  });
  const out = [];
  for (let i = 0; i < count; i++) out.push(products[i % products.length]);
  return out;
}

export async function generatePlan(dateRaw) {
  const date = String(dateRaw || DateTime.now().setZone(TIMEZONE).toISODate());
  const d = DateTime.fromISO(date, { zone: TIMEZONE });
  if (!d.isValid) throw new Error('Data do Planner inválida.');
  const slots = plannerSlots();
  const products = await chooseProductsForPlan(slots.length);
  const modes = ['product_sale', 'engagement', 'showcase'];
  const currentPosts = await listPosts();
  const jobs = [];
  for (let i = 0; i < slots.length; i++) {
    const scheduledAt = localToUtc(`${date}T${slots[i]}`);
    if (currentPosts.some(p => p.scheduledAt === scheduledAt && p.status !== 'cancelled')) continue;
    const product = products[i];
    const mode = modes[i % modes.length];
    jobs.push({ product, mode, scheduledAt });
  }
  const created = await Promise.all(jobs.map(async job => {
    const message = await generateCaption(job.product, job.mode);
    return insertPost({ product: job.product, message, scheduledAt: job.scheduledAt, origin: 'planner', plannerType: job.mode, status: 'draft' });
  }));
  return { date, timezone: TIMEZONE, created, skipped: slots.length - created.length };
}

async function graphGet(endpoint, params = {}, token = process.env.META_PAGE_ACCESS_TOKEN) {
  const version = process.env.META_GRAPH_VERSION || 'v25.0';
  const url = new URL(`https://graph.facebook.com/${version}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (token) url.searchParams.set('access_token', token);
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`);
    err.code = json?.error?.code; err.subcode = json?.error?.error_subcode; throw err;
  }
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
  const version = process.env.META_GRAPH_VERSION || 'v25.0';
  const pageId = process.env.META_PAGE_ID;
  const url = `https://graph.facebook.com/${version}/${pageId}/${endpoint}`;
  let response;
  try { response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(20000) }); }
  catch (err) { const e = new Error(`Falha de rede ao chamar a Meta: ${err.message}`); e.ambiguous = true; throw e; }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`);
    e.code = json?.error?.code; e.subcode = json?.error?.error_subcode; throw e;
  }
  return json;
}

async function publishPost(post) {
  const meta = await validateMetaConnection(true);
  if (!meta.valid) throw new Error(`Conexão Meta inválida: ${meta.reason || 'token/página não validados.'}`);
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (post.mediaKey) {
    const entry = await mediaStore().get(post.mediaKey, { type: 'blob', consistency: 'strong' });
    if (entry) {
      const form = new FormData(); form.append('caption', post.message); form.append('access_token', token);
      form.append('source', entry, `${post.mediaKey}.webp`); return graphPost('photos', form);
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
    if (!['approved', 'publishing'].includes(row.status)) {
      const e = new Error('Apenas posts aprovados podem ser publicados. Revise e aprove novamente antes de tentar.'); e.status = 409; throw e;
    }
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
    if (claim.post.productId) {
      await casProduct(claim.post.productId, p => ({ ...p, lastPostedAt: now, updatedAt: now })).catch(err => console.error('[product-last-posted]', err));
    }
    return updated;
  } catch (err) {
    const state = (err.ambiguous || metaAccepted) ? 'needs_review' : 'error';
    await casPost(id, current => {
      if (current.publishToken !== claim.token) return current;
      return { ...current, status: state, error: err.message, errorCode: String(err.code || ''), errorSubcode: String(err.subcode || ''), publishToken: null, publishLockAt: null, updatedAt: new Date().toISOString() };
    }).catch(() => {});
    throw err;
  }
}

export async function publishDuePosts(limit = 10) {
  if (String(process.env.AUTO_PUBLISH).toLowerCase() !== 'true') return { autoPublish: false, attempted: 0, published: 0, errors: [] };
  const now = new Date().toISOString();
  const due = (await listPosts()).filter(p => p.status === 'approved' && p.scheduledAt && p.scheduledAt <= now).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).slice(0, limit);
  let published = 0; const errors = [];
  for (const post of due) {
    try { await publishById(post.id); published++; }
    catch (err) { errors.push({ id: post.id, error: err.message }); }
  }
  return { autoPublish: true, attempted: due.length, published, errors };
}

export async function statusSummary() {
  const [products, posts, meta] = await Promise.all([listProducts(), listPosts(), validateMetaConnection(false)]);
  return {
    openai: Boolean(process.env.OPENAI_API_KEY), autoPublish: String(process.env.AUTO_PUBLISH).toLowerCase() === 'true',
    graphVersion: process.env.META_GRAPH_VERSION || 'v25.0', timezone: TIMEZONE, plannerSlots: plannerSlots(), meta,
    counts: { products: products.length, posts: posts.length, pending: posts.filter(p => ['draft', 'approved', 'error', 'needs_review'].includes(p.status)).length }
  };
}

export async function dataSummary() {
  const [products, posts] = await Promise.all([listProducts(), listPosts()]);
  return { products, posts, settings: { timezone: TIMEZONE, approvalRequired: true, plannerSlots: plannerSlots(), storage: 'Netlify Blobs' } };
}

export async function checkLoginRate(ip) {
  const key = `login/${crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex')}`;
  const store = systemStore(); const now = Date.now(); const windowMs = 15 * 60 * 1000; const max = 5;
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (!entry) {
      const value = { first: now, count: 1 };
      const result = await store.setJSON(key, value, { onlyIfNew: true });
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
