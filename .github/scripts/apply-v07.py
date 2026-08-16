from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'[{label}] trecho não encontrado')
    return text.replace(old, new, 1)


def sub_once(text, pattern, repl, label, flags=re.S):
    out, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'[{label}] esperado 1 match, obtido {count}')
    return out


# ---------------- agent.mjs ----------------
path = 'netlify/lib/agent.mjs'
text = read(path)

text = replace_once(
    text,
    "import net from 'node:net';\n",
    "import net from 'node:net';\nimport { copyHasUrl, stripUrls, sensitiveReasons, moderateText, extractWebEvidence, buildImagePrompt, generateImageBuffer } from './creative-ai.mjs';\n",
    'creative import'
)
text = replace_once(text, "export const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';", "export const TIMEZONE = 'America/Sao_Paulo';", 'pin timezone')
text = replace_once(text, "const POST_INDEX_LIMIT = 120;", "const POST_INDEX_LIMIT = 120;\nconst PRODUCT_INDEX_LIMIT = 1000;", 'product index limit')
text = replace_once(
    text,
    "const systemStore = () => getStore({ name: 'animaca-system', consistency: 'strong' });",
    "const systemStore = () => getStore({ name: 'animaca-system', consistency: 'strong' });\nconst jobsStore = () => getStore({ name: 'animaca-jobs', consistency: 'strong' });",
    'jobs store'
)

# Product index replaces full-scan listProducts.
product_index = r'''function compactProduct(p) {
  if (!p) return null;
  return { ...p };
}

async function ensureProductIndex() {
  const store = systemStore();
  const existing = await store.get('indexes/products-v1', { type: 'json', consistency: 'strong' });
  if (existing?.version === 1) return existing;
  const rows = await listJson(productsStore, 'product/');
  rows.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const index = { version: 1, totalProducts: rows.length, items: rows.slice(0, PRODUCT_INDEX_LIMIT).map(compactProduct), rebuiltAt: nowIso() };
  const result = await store.setJSON('indexes/products-v1', index, { onlyIfNew: true });
  if (result.modified) return index;
  return await store.get('indexes/products-v1', { type: 'json', consistency: 'strong' }) || index;
}

async function indexProduct(product, { isNew = false } = {}) {
  await ensureProductIndex();
  return mutateSystemJson('indexes/products-v1', { version: 1, totalProducts: 0, items: [] }, idx => {
    idx.version = 1;
    idx.items = Array.isArray(idx.items) ? idx.items : [];
    const found = idx.items.findIndex(x => x.id === product.id);
    if (found >= 0) idx.items.splice(found, 1);
    idx.items.unshift(compactProduct(product));
    idx.items.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    idx.items = idx.items.slice(0, PRODUCT_INDEX_LIMIT);
    if (isNew && found < 0) idx.totalProducts = Number(idx.totalProducts || 0) + 1;
    idx.updatedAt = nowIso();
    return idx;
  });
}

export async function listProducts() {
  const idx = await ensureProductIndex();
  return (idx.items || []).map(productView);
}
'''
text = sub_once(text, r"export async function listProducts\(\) \{.*?\n\}\n\nexport function productView", product_index + "\nexport function productView", 'product index')

freshness_block = r'''export function productFreshnessState(p, nowMs = Date.now(), maxDays = 14) {
  if (!p?.shopeeUrl || !p?.verified) return { fresh: false, state: 'not-ready', ageDays: null };
  if (maxDays <= 0) return { fresh: true, state: 'unchecked', ageDays: null };
  const reference = p.lastSyncSeenAt || p.verifiedAt || p.createdAt;
  const parsed = Date.parse(reference || 0);
  if (!parsed) return { fresh: false, state: 'unknown', ageDays: null };
  const ageDays = Math.max(0, (nowMs - parsed) / 86400_000);
  const missing = Number(p.missingSyncCount || 0);
  const fresh = ageDays <= maxDays && missing < 2;
  return { fresh, state: fresh ? (missing ? 'attention' : 'fresh') : 'stale', ageDays: Number(ageDays.toFixed(1)) };
}

export function productView(p) {
  if (!p) return null;
  const freshness = productFreshnessState(p, Date.now(), intEnv('PRODUCT_MAX_STALE_DAYS', 14));
  return {
    ...p,
    shopeeUrl: p.shopeeUrl || '', source: p.source || 'manual', verified: Boolean(p.verified),
    mediaUrl: p.mediaKey ? `/media/${encodeURIComponent(p.mediaKey)}` : '',
    catalogFresh: freshness.fresh, catalogState: freshness.state, catalogAgeDays: freshness.ageDays
  };
}
'''
text = sub_once(text, r"export function productView\(p\) \{.*?\n\}\n\nexport function buildFinalMessage", freshness_block + "\nexport function buildFinalMessage", 'freshness/product view')

# casProduct maintains the product index.
text = replace_once(
    text,
    "    if (result.modified) return productView(next);",
    "    if (result.modified) { await indexProduct(next).catch(err => console.error('[product-index]', err)); return productView(next); }",
    'casProduct index'
)

persist_block = r'''export async function persistSafeImage(file) {
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

async function persistRemoteImageUrl(raw) {
  const url = validateHttpsUrl(raw, { optional: false });
  const { response } = await fetchPublicHttps(url, { headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*' }, timeout: 9000 });
  if (!response.ok) throw new Error(`Não foi possível baixar a imagem externa (HTTP ${response.status}).`);
  const bytes = await readResponseLimited(response);
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) throw new Error('A URL informada não retornou uma imagem JPEG, PNG ou WEBP válida.');
  const output = await sharp(bytes, { failOn: 'error' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  return saveGeneratedMedia(output, { mime: 'image/webp', source: 'remote-import', originalUrl: url.slice(0, 500) });
}

async function mediaExists(key) {
  if (!key) return false;
  try {
    const entry = await mediaStore().getWithMetadata(String(key), { type: 'blob', consistency: 'strong' });
    return Boolean(entry?.data && Number(entry.data.size || 0) > 0);
  } catch {
    return false;
  }
}
'''
text = sub_once(text, r"export async function persistSafeImage\(file\) \{.*?\n\}\n\nasync function saveGeneratedMedia", persist_block + "\nasync function saveGeneratedMedia", 'image persistence')

create_product = r'''export async function createProduct({ name, category = '', price = '', description = '', imageUrl = '', shopeeUrl = '', file = null, source = 'manual' }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Nome do produto é obrigatório.');
  const saved = file ? await persistSafeImage(file) : (String(imageUrl || '').trim() ? await persistRemoteImageUrl(imageUrl) : null);
  const link = await normalizeShopeeUrl(shopeeUrl);
  if (link) {
    const duplicate = (await listProducts()).find(p => p.shopeeUrl === link);
    if (duplicate) { const e = new Error(`Este link da Shopee já pertence ao produto “${duplicate.name}”.`); e.status = 409; throw e; }
  }
  const now = nowIso();
  const ready = Boolean(link && saved?.mediaKey);
  const p = {
    id: uuid(), name: cleanName, category: String(category || '').trim(), price: String(price || '').trim(),
    description: String(description || '').trim(), imageUrl: '', shopeeUrl: link,
    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,
    verified: ready, verifiedAt: ready ? now : null, observedPrice: '', lastSyncSeenAt: null, lastCatalogCheckAt: now,
    missingSyncCount: 0, catalogStatus: ready ? 'confirmed' : 'review', lastPostedAt: null, performanceScore: 0, createdAt: now, updatedAt: null
  };
  const result = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível cadastrar o produto.');
  await indexProduct(p, { isNew: true }).catch(err => console.error('[product-index]', err));
  return productView(p);
}
'''
text = sub_once(text, r"export async function createProduct\(\{.*?\n\}\n\nexport async function updateProduct", create_product + "\nexport async function updateProduct", 'createProduct')

update_product = r'''export async function updateProduct(id, body) {
  const remoteSaved = ('imageUrl' in body && String(body.imageUrl || '').trim()) ? await persistRemoteImageUrl(body.imageUrl) : null;
  const updated = await casProduct(id, async current => {
    if ('name' in body) { const n = String(body.name || '').trim(); if (!n) throw new Error('Nome é obrigatório.'); current.name = n; }
    if ('category' in body) current.category = String(body.category || '').trim();
    if ('price' in body) current.price = String(body.price || '').trim();
    if ('description' in body) current.description = String(body.description || '').trim();
    if (remoteSaved) { current.mediaKey = remoteSaved.mediaKey; current.imageMime = remoteSaved.imageMime; current.imageUrl = ''; }
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
        current.missingSyncCount = 0;
        current.catalogStatus = 'review';
      }
    }
    if ('active' in body) current.active = parseBooleanInput(body.active);
    current.updatedAt = nowIso();
    return current;
  });
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}
'''
text = sub_once(text, r"export async function updateProduct\(id, body\) \{.*?\n\}\n\nexport async function updateProductImage", update_product + "\nexport async function updateProductImage", 'updateProduct')

text = replace_once(
    text,
    "const updated = await casProduct(id, p => ({ ...p, mediaKey: saved.mediaKey, imageMime: saved.imageMime, updatedAt: nowIso() }));",
    "const updated = await casProduct(id, p => ({ ...p, mediaKey: saved.mediaKey, imageMime: saved.imageMime, imageUrl: '', updatedAt: nowIso() }));",
    'update image clears remote'
)

text = replace_once(
    text,
    "      ...p,\n      price: p.price || p.observedPrice || '', active: true, verified: true, verifiedAt: nowIso(), updatedAt: nowIso()",
    "      ...p,\n      price: p.price || p.observedPrice || '', active: true, verified: true, verifiedAt: nowIso(), lastCatalogCheckAt: nowIso(), missingSyncCount: 0, catalogStatus: 'confirmed', updatedAt: nowIso()",
    'confirm freshness'
)

# deleteProduct updates the index too.
text = replace_once(
    text,
    "  await productsStore().delete(`product/${id}`);\n  // Mantemos a mídia: posts históricos podem referenciá-la. Limpeza é feita por rotina separada futura.\n  return { ok: true, mediaPreserved: Boolean(p.mediaKey) };",
    "  await productsStore().delete(`product/${id}`);\n  await mutateSystemJson('indexes/products-v1', { version: 1, totalProducts: 0, items: [] }, idx => { idx.items = (idx.items || []).filter(x => x.id !== id); idx.totalProducts = Math.max(0, Number(idx.totalProducts || 1) - 1); idx.updatedAt = nowIso(); return idx; }).catch(() => {});\n  return { ok: true, mediaPreserved: Boolean(p.mediaKey) };",
    'delete product index'
)

text = replace_once(text, "return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 24000, maxRetries: 0 });", "return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 0 });", 'openai timeout')

text = replace_once(
    text,
    "    copy: intEnv('AI_DAILY_COPY_LIMIT', 8),\n    web: intEnv('AI_DAILY_WEB_LIMIT', 4),\n    sync: intEnv('AI_DAILY_SYNC_LIMIT', 1)",
    "    copy: intEnv('AI_DAILY_COPY_LIMIT', 8),\n    web: intEnv('AI_DAILY_WEB_LIMIT', 4),\n    sync: intEnv('AI_DAILY_SYNC_LIMIT', 1),\n    image: intEnv('AI_DAILY_IMAGE_LIMIT', 6)",
    'AI limits image'
)
text = text.replace("{ date, copy: 0, web: 0, sync: 0, failures: 0 }", "{ date, copy: 0, web: 0, sync: 0, image: 0, failures: 0 }")

# Current model defaults + URL stripping.
text = replace_once(text, "model: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini',", "model: process.env.OPENAI_COPY_MODEL || 'gpt-5.6-luna',", 'copy model sale')
text = replace_once(text, "const message = response.output_text?.trim();", "const message = stripUrls(response.output_text?.trim());", 'strip sale URL')
text = replace_once(text, "model: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini',", "model: process.env.OPENAI_COPY_MODEL || 'gpt-5.6-luna',", 'copy model growth')
text = replace_once(text, "const message = String(parsed.message || '').trim();", "const message = stripUrls(String(parsed.message || '').trim());", 'strip growth URL')

hype_function = r'''export async function generateHypePost() {
  const prompt = `Pesquise na web AGORA e encontre UM assunto dos últimos 3 dias com forte afinidade ao público geek brasileiro: anime, mangá, games, filmes/séries, trailers, lançamentos, eventos ou fandoms.\n\nCrie um post curto para a Animaca Geek aproveitar a conversa do momento, sem fingir que a loja vende um produto relacionado.\n\nRegras:\n- Confirme que é recente; se houver dúvida, escolha outro.\n- Evite política, tragédias, crimes, morte, boatos, conteúdo adulto, apostas, drogas e polêmicas sensíveis.\n- Não invente data, anúncio ou fato.\n- Não copie manchetes.\n- A mensagem pública NÃO deve conter URL.\n- Termine com pergunta específica.\n- 2 a 4 hashtags.\n- Retorne JSON puro: {"topic":"assunto específico","confidence":0.0,"message":"texto final","sources":[{"url":"https://...","title":"fonte","publishedAt":"ISO ou data conhecida"}]}.\n- confidence deve refletir a segurança de que o assunto é realmente recente e adequado.\n\nMemória recente para não repetir:\n${await compactMemory() || 'sem posts recentes'}`;
  const response = await aiResponse({
    kind: 'web',
    model: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    tools: [{ type: 'web_search' }], input: prompt
  });
  const parsed = extractJson(response.output_text);
  const message = stripUrls(String(parsed.message || '').trim());
  if (!message) throw new Error('A IA não encontrou um hype adequado agora.');
  const citations = extractWebEvidence(response);
  const claimed = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = citations.map(source => {
    const match = claimed.find(item => {
      try { return new URL(item.url).hostname.replace(/^www\./, '') === source.domain; } catch { return false; }
    });
    return { ...source, publishedAt: match?.publishedAt ? String(match.publishedAt).slice(0, 40) : null };
  }).slice(0, 5);
  return {
    message,
    topic: String(parsed.topic || 'hype geek').slice(0, 120),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
    sources,
    hypeCheckedAt: nowIso()
  };
}
'''
text = sub_once(text, r"export async function generateHypePost\(\) \{.*?\n\}\n\nexport async function syncShopeeCatalog", hype_function + "\nexport async function syncShopeeCatalog", 'generateHypePost')

sync_function = r'''export async function syncShopeeCatalog({ force = false } = {}) {
  const last = await systemStore().get('shopee-last-sync', { type: 'json', consistency: 'strong' }).catch(() => null);
  const minHours = intEnv('SHOPEE_SYNC_MIN_HOURS', 20);
  if (!force && last?.checkedAt && Date.now() - Date.parse(last.checkedAt) < minHours * 3600_000) {
    const e = new Error(`A loja já foi sincronizada recentemente. Aguarde ${minHours}h entre buscas para economizar API.`);
    e.status = 429;
    throw e;
  }
  const prompt = `Use busca web para inspecionar SOMENTE a loja Shopee ${SHOPEE_STORE_URL}. Localize produtos reais visíveis dessa loja e links individuais.\nRetorne JSON puro no formato {"products":[{"name":"...","price":"R$ ...","url":"https://shopee.com.br/...","confidence":0.0}]}.\nMáximo 30. Não invente item, preço nem URL. Itens novos serão enviados para revisão humana, então prefira precisão a quantidade.`;
  const response = await aiResponse({
    kind: 'sync', model: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    tools: [{ type: 'web_search' }], input: prompt
  });
  const parsed = extractJson(response.output_text);
  const incoming = Array.isArray(parsed.products) ? parsed.products : [];
  if (!incoming.length) throw new Error('Nenhum candidato com link individual foi encontrado.');
  const existing = await listProducts();
  const byUrl = new Map(existing.filter(p => p.shopeeUrl).map(p => [p.shopeeUrl, p]));
  const seenUrls = new Set();
  const now = nowIso();
  let created = 0, updated = 0, ignored = 0;
  const samples = [];
  for (const item of incoming.slice(0, 30)) {
    try {
      const name = String(item.name || '').trim();
      const url = await normalizeShopeeUrl(item.url);
      const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0)));
      if (!name || !url || confidence < 0.55) { ignored++; continue; }
      if (seenUrls.has(url)) { ignored++; continue; }
      seenUrls.add(url);
      const old = byUrl.get(url);
      if (old) {
        await casProduct(old.id, p => ({
          ...p,
          observedPrice: String(item.price || '').trim(), lastSyncSeenAt: now, lastCatalogCheckAt: now,
          missingSyncCount: 0, catalogStatus: 'seen', syncConfidence: confidence, updatedAt: now
        }));
        updated++;
      } else {
        const p = {
          id: uuid(), name, category: 'Shopee', price: '', observedPrice: String(item.price || '').trim(),
          description: 'Candidato encontrado na loja pública da Shopee. Confirme antes de usar em automação.',
          imageUrl: '', shopeeUrl: url, mediaKey: '', imageMime: '', active: false, verified: false, verifiedAt: null,
          source: 'shopee_sync', syncConfidence: confidence, lastSyncSeenAt: now, lastCatalogCheckAt: now, missingSyncCount: 0, catalogStatus: 'seen', lastPostedAt: null, performanceScore: 0,
          createdAt: now, updatedAt: null
        };
        const r = await productsStore().setJSON(`product/${p.id}`, p, { onlyIfNew: true });
        if (r.modified) { created++; byUrl.set(url, productView(p)); await indexProduct(p, { isNew: true }).catch(() => {}); }
        else ignored++;
      }
      if (samples.length < 5) samples.push({ name, url, confidence });
    } catch { ignored++; }
  }
  for (const product of existing.filter(p => p.shopeeUrl && p.verified)) {
    if (seenUrls.has(product.shopeeUrl)) continue;
    await casProduct(product.id, p => ({
      ...p, lastCatalogCheckAt: now, missingSyncCount: Number(p.missingSyncCount || 0) + 1,
      catalogStatus: Number(p.missingSyncCount || 0) + 1 >= 2 ? 'stale' : 'not-seen', updatedAt: now
    })).catch(() => {});
  }
  const result = { checkedAt: now, created, updated, ignored, found: incoming.length, seen: seenUrls.size, storeUrl: SHOPEE_STORE_URL };
  await systemStore().setJSON('shopee-last-sync', result);
  await audit('shopee_sync', result);
  return { ...result, samples };
}
'''
text = sub_once(text, r"export async function syncShopeeCatalog\(\{ force = false \} = \{\}\) \{.*?\n\}\n\nfunction xmlEsc", sync_function + "\nfunction xmlEsc", 'syncShopeeCatalog')

# Upgrade creative engine to accept an AI background.
text = replace_once(
    text,
    "async function createCreative({ type, message, topic, product, salt = '' }) {",
    "async function createCreative({ type, message, topic, product, salt = '', backgroundBuffer = null, visualSource = 'template', aiModel = null }) {",
    'creative signature'
)
text = replace_once(
    text,
    "  const base = sharp({ create: { width: 1080, height: 1080, channels: 4, background: '#ffffff' } });\n  const composites = [];",
    "  const base = backgroundBuffer ? sharp(backgroundBuffer).rotate().resize(1080, 1080, { fit: 'cover', position: 'centre' }) : sharp({ create: { width: 1080, height: 1080, channels: 4, background: '#ffffff' } });\n  const composites = [];",
    'creative AI base'
)
text = sub_once(
    text,
    r"  const decorations = variant % 3 === 0.*?  composites\.push\(\{ input: Buffer\.from\(bg\), left: 0, top: 0 \}\);\n\n  let titleX",
    r'''  const decorations = variant % 3 === 0
    ? `<circle cx="970" cy="110" r="180" fill="${soft}"/><circle cx="80" cy="980" r="210" fill="${soft}"/>`
    : variant % 3 === 1
      ? `<rect x="0" y="0" width="1080" height="220" fill="${soft}"/><circle cx="1020" cy="860" r="230" fill="${soft}"/>`
      : `<path d="M0 0 H1080 V180 C760 310 360 40 0 220Z" fill="${soft}"/><path d="M1080 1080 H0 V930 C340 800 750 1060 1080 890Z" fill="${soft}"/>`;
  const bg = backgroundBuffer
    ? `<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="1080" fill="#fff" opacity="0.22"/><rect x="54" y="54" width="972" height="972" rx="38" fill="none" stroke="#ffffff" stroke-opacity="0.68" stroke-width="3"/></svg>`
    : `<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="1080" fill="#fff"/>${decorations}<rect x="54" y="54" width="972" height="972" rx="38" fill="none" stroke="#e5e7eb" stroke-width="2"/></svg>`;
  composites.push({ input: Buffer.from(bg), left: 0, top: 0 });

  let titleX''',
    'creative bg segment'
)

# Six genuinely different sale placements.
text = sub_once(
    text,
    r"  if \(isSale && image\) \{.*?\n  \} else \{\n    titleY = variant % 2 \? 420 : 360;\n    titleSize = variant % 2 \? 70 : 76;\n    titleWidth = 860;\n  \}",
    r'''  if (isSale && image) {
    if (variant === 0) {
      const photo = await sharp(image).rotate().resize(860, 540, { fit: 'contain', background: '#ffffff00' }).webp({ quality: 94 }).toBuffer();
      composites.push({ input: photo, left: 110, top: 125 }); titleY = 720; titleWidth = 850; titleSize = 46;
    } else if (variant === 1) {
      const photo = await sharp(image).rotate().resize(505, 760, { fit: 'contain', background: '#ffffff00' }).webp({ quality: 94 }).toBuffer();
      composites.push({ input: photo, left: 520, top: 180 }); titleX = 90; titleY = 410; titleWidth = 390; titleSize = 52;
    } else if (variant === 2) {
      const photo = await sharp(image).rotate().resize(505, 760, { fit: 'contain', background: '#ffffff00' }).webp({ quality: 94 }).toBuffer();
      composites.push({ input: photo, left: 55, top: 180 }); titleX = 600; titleY = 410; titleWidth = 390; titleSize = 52;
    } else if (variant === 3) {
      const photo = await sharp(image).rotate().resize(650, 650, { fit: 'contain', background: '#ffffff00' }).webp({ quality: 94 }).toBuffer();
      composites.push({ input: photo, left: 360, top: 255 }); titleX = 90; titleY = 350; titleWidth = 330; titleSize = 48;
    } else if (variant === 4) {
      const photo = await sharp(image).rotate().resize(720, 620, { fit: 'contain', background: '#ffffff00' }).webp({ quality: 94 }).toBuffer();
      composites.push({ input: photo, left: 180, top: 310 }); titleX = 90; titleY = 220; titleWidth = 900; titleSize = 48;
    } else {
      const photo = await sharp(image).rotate().resize(560, 720, { fit: 'contain', background: '#ffffff00' }).webp({ quality: 94 }).toBuffer();
      composites.push({ input: photo, left: 260, top: 120 }); titleX = 540; titleY = 760; titleWidth = 430; titleSize = 45;
    }
  } else {
    titleY = variant % 2 ? 420 : 360;
    titleSize = variant % 2 ? 70 : 76;
    titleWidth = 860;
  }''',
    'six sale layouts'
)
text = text.replace('font-family="Arial, Helvetica, sans-serif"', 'font-family="DejaVu Sans, Arial, Helvetica, sans-serif"')
text = replace_once(
    text,
    "  const saved = await saveGeneratedMedia(output, { mime: 'image/webp', source: 'creative-engine-v2', type, variant });\n  return { ...saved, variant };",
    "  const saved = await saveGeneratedMedia(output, { mime: 'image/webp', source: visualSource, type, variant, aiModel: aiModel || '' });\n  return { ...saved, variant, visualSource, aiModel };",
    'creative metadata'
)

ai_creative_helper = r'''async function createAiCreative({ type, message, topic, product, salt = '' }) {
  await consumeAiBudget('image');
  const prompt = buildImagePrompt({ type, topic, category: product?.category || '' });
  const generated = await generateImageBuffer({
    apiKey: process.env.OPENAI_API_KEY,
    prompt,
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    quality: process.env.OPENAI_IMAGE_QUALITY || 'low',
    size: '1024x1024'
  });
  const backgroundBuffer = await sharp(generated.buffer, { failOn: 'error' }).rotate().resize(1080, 1080, { fit: 'cover' }).webp({ quality: 92 }).toBuffer();
  return createCreative({ type, message, topic, product, salt, backgroundBuffer, visualSource: 'openai-image', aiModel: generated.model });
}

async function assessTextSafety(message) {
  const local = sensitiveReasons(message);
  let moderation;
  try {
    moderation = await moderateText({ apiKey: process.env.OPENAI_API_KEY, text: message });
  } catch (err) {
    moderation = { checked: false, flagged: false, categories: [], error: err.message };
  }
  return { moderation, sensitiveReasons: local };
}
'''
text = replace_once(text, "export function textSimilarity(a, b) {", ai_creative_helper + "\nexport function textSimilarity(a, b) {", 'ai creative helper')

quality_function = r'''async function qualityGate(post, product = null) {
  const blockers = [], warnings = [];
  let score = 100;
  const msg = String(post.message || '').trim();
  if (msg.length < 45) { score -= 20; warnings.push('copy muito curta'); }
  if (msg.length > 1800) { score -= 15; warnings.push('copy muito longa'); }
  if (/\b(lorem ipsum|placeholder|insira aqui|example\.com)\b/i.test(msg)) blockers.push('placeholder na copy');
  if (copyHasUrl(msg)) blockers.push('a copy contém URL; links públicos são inseridos somente pelo servidor');
  const localSensitive = Array.from(new Set([...(post.sensitiveReasons || []), ...sensitiveReasons(`${post.topic || ''} ${msg}`)]));
  if (localSensitive.length) blockers.push(`tema sensível: ${localSensitive.join(', ')}`);
  if (post.moderation?.flagged) blockers.push('moderação de segurança bloqueou o conteúdo');
  if (post.origin === 'planner' && post.moderation?.checked === false) warnings.push('moderação automática não foi confirmada');

  const recent = (await listRecentPosts(35)).filter(p => p.status === 'published');
  const maxSimilarity = recent.reduce((m, p) => Math.max(m, textSimilarity(msg, p.message)), 0);
  if (maxSimilarity >= 0.82) blockers.push('copy muito parecida com publicação recente');
  else if (maxSimilarity >= 0.65) { score -= 15; warnings.push('estrutura semelhante a post recente'); }

  if (post.plannerType === 'sale') {
    if (!product) blockers.push('produto não encontrado');
    if (product && !product.active) blockers.push('produto inativo');
    if (product && !product.verified) blockers.push('produto ainda não confirmado');
    if (!post.shopeeUrl || post.shopeeUrl !== product?.shopeeUrl) blockers.push('link Shopee não confere com o produto atual');
    if (!product?.mediaKey) blockers.push('produto sem foto real interna validada');
    if (product && !productFreshnessState(product, Date.now(), intEnv('PRODUCT_MAX_STALE_DAYS', 14)).fresh) blockers.push('produto sem verificação recente no catálogo');
  }
  if (post.plannerType === 'hype') {
    if (Number(post.hypeConfidence ?? 0) < 0.70) blockers.push('confiança insuficiente no hype');
    if (!Array.isArray(post.sources) || !post.sources.length) blockers.push('hype sem evidência de fonte da pesquisa web');
    if (!post.hypeCheckedAt || Date.now() - Date.parse(post.hypeCheckedAt) > intEnv('HYPE_MAX_AGE_HOURS', 4) * 3600_000) blockers.push('hype ficou velho demais');
  }
  if (post.plannerType === 'growth' && !msg.includes('?')) { score -= 10; warnings.push('post de crescimento sem pergunta clara'); }
  if (post.origin === 'planner' && !post.mediaKey) blockers.push('post automático sem mídia interna validada');
  if (post.origin === 'planner' && boolEnv('REQUIRE_AI_VISUAL', true) && post.visualMode !== 'ai') blockers.push('arte de IA não foi gerada; revisão manual necessária');
  if (post.visualAiError) warnings.push('a geração visual de IA falhou e houve fallback');

  score = Math.max(0, score);
  if (blockers.length) score = Math.min(score, 59);
  return { score, blockers, warnings, maxSimilarity: Number(maxSimilarity.toFixed(3)), canAutoApprove: blockers.length === 0 && score >= intEnv('AUTO_APPROVE_MIN_SCORE', 85) };
}
'''
text = sub_once(text, r"async function qualityGate\(post, product = null\) \{.*?\n\}\n\nasync function insertPost", quality_function + "\nasync function insertPost", 'qualityGate')

# Extend insertPost data model.
text = replace_once(
    text,
    "async function insertPost({ product = null, displayName = '', message, imageUrl = '', mediaKey = '', imageMime = '', scheduledAt = null, origin = 'manual', plannerType = null, status = 'draft', topic = '', hypeConfidence = null, dailyDate = null, generatedVisual = false }) {",
    "async function insertPost({ product = null, displayName = '', message, imageUrl = '', mediaKey = '', imageMime = '', scheduledAt = null, origin = 'manual', plannerType = null, status = 'draft', topic = '', hypeConfidence = null, dailyDate = null, generatedVisual = false, visualMode = 'template', visualAiError = null, sources = [], hypeCheckedAt = null, moderation = null, sensitiveReasons = [] }) {",
    'insertPost signature'
)
text = replace_once(
    text,
    "    origin, plannerType, topic, hypeConfidence, dailyDate, quality: null, performance: null, generatedVisual\n  };",
    "    origin, plannerType, topic, hypeConfidence, dailyDate, quality: null, performance: null, generatedVisual, visualMode, visualAiError,\n    sources: Array.isArray(sources) ? sources.slice(0, 6) : [], hypeCheckedAt, moderation, sensitiveReasons: Array.isArray(sensitiveReasons) ? sensitiveReasons : []\n  };",
    'insertPost fields'
)

# Compact index needs v0.7 fields.
text = replace_once(
    text,
    "    'plannerType','topic','dailyDate','quality','performance','generatedVisual'",
    "    'plannerType','topic','dailyDate','quality','performance','generatedVisual','visualMode','visualAiError','sources','hypeCheckedAt','hypeConfidence','moderation','sensitiveReasons'",
    'compact post fields'
)

build_post = r'''async function buildPostForType(type, scheduledAt, dailyDate, origin = 'planner') {
  const spec = typeSpec(type);
  if (type === 'sale') {
    const product = await chooseSaleProduct();
    const generated = await generateSaleCaption(product);
    const safety = await assessTextSafety(generated.message);
    let creative = null, visualAiError = null;
    try { creative = await createAiCreative({ type, message: generated.message, topic: generated.topic, product }); }
    catch (err) { visualAiError = err.message; console.error('[creative-ai-sale]', err); creative = await createCreative({ type, message: generated.message, topic: generated.topic, product }).catch(() => null); }
    return insertPost({ product, message: generated.message, scheduledAt, origin, plannerType: type, topic: generated.topic, dailyDate,
      mediaKey: creative?.mediaKey || product.mediaKey || '', imageMime: creative?.imageMime || product.imageMime || '', imageUrl: '', generatedVisual: Boolean(creative),
      visualMode: creative?.visualSource === 'openai-image' ? 'ai' : 'fallback', visualAiError, moderation: safety.moderation, sensitiveReasons: safety.sensitiveReasons });
  }
  if (type === 'hype') {
    const generated = await generateHypePost();
    const safety = await assessTextSafety(`${generated.topic} ${generated.message}`);
    let creative = null, visualAiError = null;
    try { creative = await createAiCreative({ type, message: generated.message, topic: generated.topic }); }
    catch (err) { visualAiError = err.message; console.error('[creative-ai-hype]', err); creative = await createCreative({ type, message: generated.message, topic: generated.topic }).catch(() => null); }
    return insertPost({ displayName: spec.label, message: generated.message, scheduledAt, origin, plannerType: type, topic: generated.topic,
      hypeConfidence: generated.confidence, dailyDate, mediaKey: creative?.mediaKey || '', imageMime: creative?.imageMime || '', generatedVisual: Boolean(creative),
      visualMode: creative?.visualSource === 'openai-image' ? 'ai' : 'fallback', visualAiError, sources: generated.sources, hypeCheckedAt: generated.hypeCheckedAt,
      moderation: safety.moderation, sensitiveReasons: safety.sensitiveReasons });
  }
  const generated = await generateGrowthPost();
  const safety = await assessTextSafety(generated.message);
  let creative = null, visualAiError = null;
  try { creative = await createAiCreative({ type, message: generated.message, topic: generated.topic }); }
  catch (err) { visualAiError = err.message; console.error('[creative-ai-growth]', err); creative = await createCreative({ type, message: generated.message, topic: generated.topic }).catch(() => null); }
  return insertPost({ displayName: spec.label, message: generated.message, scheduledAt, origin, plannerType: type, topic: generated.topic, dailyDate,
    mediaKey: creative?.mediaKey || '', imageMime: creative?.imageMime || '', generatedVisual: Boolean(creative),
    visualMode: creative?.visualSource === 'openai-image' ? 'ai' : 'fallback', visualAiError, moderation: safety.moderation, sensitiveReasons: safety.sensitiveReasons });
}
'''
text = sub_once(text, r"async function buildPostForType\(type, scheduledAt, dailyDate, origin = 'planner'\) \{.*?\n\}\n\nexport async function generateManualSale", build_post + "\nexport async function generateManualSale", 'buildPostForType')

manual_sale = r'''export async function generateManualSale(productId) {
  const product = await getProduct(productId);
  if (!product || !product.active || !product.verified || !product.mediaKey) throw new Error('Produto precisa estar ativo, confirmado e com foto real interna.');
  const generated = await generateSaleCaption(product);
  const safety = await assessTextSafety(generated.message);
  let creative = null, visualAiError = null;
  try { creative = await createAiCreative({ type: 'sale', message: generated.message, topic: generated.topic, product, salt: uuid() }); }
  catch (err) { visualAiError = err.message; creative = await createCreative({ type: 'sale', message: generated.message, topic: generated.topic, product, salt: uuid() }); }
  return insertPost({ product, message: generated.message, origin: 'manual', plannerType: 'sale', topic: generated.topic,
    mediaKey: creative?.mediaKey || product.mediaKey || '', imageMime: creative?.imageMime || product.imageMime || '', imageUrl: '', generatedVisual: Boolean(creative),
    visualMode: creative?.visualSource === 'openai-image' ? 'ai' : 'fallback', visualAiError, moderation: safety.moderation, sensitiveReasons: safety.sensitiveReasons });
}
'''
text = sub_once(text, r"export async function generateManualSale\(productId\) \{.*?\n\}\n\nexport async function generateManualType", manual_sale + "\nexport async function generateManualType", 'manual sale')

manual_type = r'''export async function generateManualType(type, productId = null) {
  if (type === 'sale') return generateManualSale(productId);
  if (!['hype', 'growth'].includes(type)) throw new Error('Tipo de teste inválido.');
  const generated = type === 'hype' ? await generateHypePost() : await generateGrowthPost();
  const safety = await assessTextSafety(`${generated.topic || ''} ${generated.message}`);
  let creative = null, visualAiError = null;
  try { creative = await createAiCreative({ type, message: generated.message, topic: generated.topic, salt: uuid() }); }
  catch (err) { visualAiError = err.message; creative = await createCreative({ type, message: generated.message, topic: generated.topic, salt: uuid() }); }
  return insertPost({
    displayName: type === 'hype' ? 'Hype do momento' : 'Crescimento', message: generated.message, origin: 'manual', plannerType: type, topic: generated.topic,
    hypeConfidence: generated.confidence ?? null, mediaKey: creative.mediaKey, imageMime: creative.imageMime, generatedVisual: true,
    visualMode: creative?.visualSource === 'openai-image' ? 'ai' : 'fallback', visualAiError, sources: generated.sources || [], hypeCheckedAt: generated.hypeCheckedAt || null,
    moderation: safety.moderation, sensitiveReasons: safety.sensitiveReasons
  });
}
'''
text = sub_once(text, r"export async function generateManualType\(type, productId = null\) \{.*?\n\}\n\nexport async function regeneratePostCreative", manual_type + "\nexport async function regeneratePostCreative", 'manual type')

# AI regeneration worker helper.
regen_ai = r'''export async function regeneratePostCreativeAi(id) {
  const current = await getPost(id);
  if (!current) throw new Error('Post não encontrado.');
  if (['published', 'publishing'].includes(current.status)) throw new Error('Não é possível trocar a arte de um post já publicado/em publicação.');
  const product = current.productId ? await getProduct(current.productId) : null;
  const creative = await createAiCreative({ type: current.plannerType || 'growth', message: current.message, topic: current.topic, product, salt: uuid() });
  return casPost(id, async row => {
    row.mediaKey = creative.mediaKey; row.imageMime = creative.imageMime; row.imageUrl = ''; row.generatedVisual = true; row.visualMode = 'ai'; row.visualAiError = null; row.creativeVariant = creative.variant;
    if (row.status === 'approved') row.status = 'draft';
    row.quality = await qualityGate(row, product); row.updatedAt = nowIso(); return row;
  });
}
'''
text = replace_once(text, "export async function patchPost(id, body) {", regen_ai + "\nexport async function patchPost(id, body) {", 'regenerate AI')

# patchPost moderation before CAS and carries safety.
text = replace_once(
    text,
    "export async function patchPost(id, body) {\n  const updated = await casPost(id, async current => {",
    "export async function patchPost(id, body) {\n  const incomingMessage = 'message' in body ? String(body.message || '').trim() : null;\n  const safety = incomingMessage ? await assessTextSafety(incomingMessage) : null;\n  const updated = await casPost(id, async current => {",
    'patch safety precheck'
)
text = replace_once(
    text,
    "      current.message = m;\n    }",
    "      current.message = stripUrls(m);\n      current.moderation = safety?.moderation || current.moderation;\n      current.sensitiveReasons = safety?.sensitiveReasons || current.sensitiveReasons || [];\n    }",
    'patch safety assign'
)

# Product selection requires fresh catalog.
text = replace_once(
    text,
    "  const products = (await listProducts()).filter(p => p.active && p.verified && p.shopeeUrl && (p.mediaKey || p.imageUrl));",
    "  const products = (await listProducts()).filter(p => p.active && p.verified && p.shopeeUrl && p.mediaKey && productFreshnessState(p, Date.now(), intEnv('PRODUCT_MAX_STALE_DAYS', 14)).fresh);",
    'choose fresh products'
)
text = replace_once(
    text,
    "if (!products.length) throw new Error('Nenhum produto pronto para venda: precisa estar ativo, confirmado, com link Shopee e foto real.');",
    "if (!products.length) throw new Error('Nenhum produto pronto para venda: precisa estar ativo, confirmado, com link Shopee, foto interna e catálogo recente.');",
    'choose sale message'
)

# Increase prepare lock safety for background jobs.
text = replace_once(text, "Date.now() - Date.parse(slot.lockedAt || 0) < 8 * 60_000", "Date.now() - Date.parse(slot.lockedAt || 0) < 14 * 60_000", 'prepare lock')

# Background dispatcher + durable manual jobs inserted after generatePlan.
dispatch_jobs = r'''function workerSecret() {
  return process.env.WORKER_SECRET || process.env.SESSION_SECRET || '';
}

async function dispatchBackground(payload) {
  const base = process.env.URL;
  const secret = workerSecret();
  if (!base) throw new Error('URL do site Netlify não disponível para disparar o worker.');
  if (!secret) throw new Error('SESSION_SECRET/WORKER_SECRET não disponível para proteger o worker.');
  const response = await fetch(new URL('/.netlify/functions/content-worker', base), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-animaca-worker-secret': secret },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
  });
  if (!response.ok && response.status !== 202) throw new Error(`Não foi possível disparar o worker (HTTP ${response.status}).`);
  return { dispatched: true, at: nowIso(), action: payload.action };
}

export async function dispatchPrepareDailySlot(type) {
  if (!boolEnv('AUTO_PLAN', false)) return { autoPlan: false, type };
  const date = DateTime.now().setZone(TIMEZONE).toISODate();
  return dispatchBackground({ action: 'prepare', type, date });
}

export async function dispatchAutoShopeeSync() {
  if (!boolEnv('AUTO_SYNC_SHOPEE', false)) return { autoSyncShopee: false };
  return dispatchBackground({ action: 'shopee-sync' });
}

export async function dispatchCleanupMedia() {
  return dispatchBackground({ action: 'cleanup-media' });
}

async function getJobEntry(id) {
  const entry = await jobsStore().getWithMetadata(`job/${id}`, { type: 'json', consistency: 'strong' });
  return entry ? { job: entry.data, etag: entry.etag } : null;
}

async function casJob(id, mutate, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const entry = await getJobEntry(id); if (!entry) throw new Error('Job não encontrado.');
    const next = await mutate(structuredClone(entry.job));
    const result = await jobsStore().setJSON(`job/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) return next;
  }
  throw new Error('Conflito ao atualizar job.');
}

export async function getJob(id) {
  const entry = await getJobEntry(id);
  return entry?.job || null;
}

async function queueJob(data) {
  const job = { id: uuid(), status: 'queued', createdAt: nowIso(), updatedAt: nowIso(), error: null, result: null, ...data };
  const result = await jobsStore().setJSON(`job/${job.id}`, job, { onlyIfNew: true });
  if (!result.modified) throw new Error('Não foi possível criar o job.');
  try { await dispatchBackground({ action: 'job', jobId: job.id }); }
  catch (err) { await casJob(job.id, x => ({ ...x, status: 'error', error: err.message, updatedAt: nowIso() })).catch(() => {}); throw err; }
  return job;
}

export async function queueManualGeneration(type, productId = null) {
  if (!['sale', 'hype', 'growth'].includes(type)) throw new Error('Tipo de geração inválido.');
  return queueJob({ kind: 'manual-generation', type, productId });
}

export async function queueCreativeGeneration(postId) {
  if (!postId) throw new Error('Post obrigatório.');
  return queueJob({ kind: 'creative-ai', postId });
}

export async function runGenerationJob(id) {
  const claim = await casJob(id, job => {
    if (job.status === 'complete') return job;
    if (job.status === 'running' && Date.now() - Date.parse(job.updatedAt || 0) < 14 * 60_000) return job;
    return { ...job, status: 'running', updatedAt: nowIso(), error: null };
  });
  if (claim.status === 'complete') return claim;
  if (claim.status === 'running' && claim.result) return claim;
  try {
    let result;
    if (claim.kind === 'manual-generation') result = await generateManualType(claim.type, claim.productId || null);
    else if (claim.kind === 'creative-ai') result = await regeneratePostCreativeAi(claim.postId);
    else throw new Error('Tipo de job desconhecido.');
    return await casJob(id, job => ({ ...job, status: 'complete', result: { postId: result.id }, updatedAt: nowIso(), completedAt: nowIso() }));
  } catch (err) {
    await casJob(id, job => ({ ...job, status: 'error', error: err.message, updatedAt: nowIso(), completedAt: nowIso() })).catch(() => {});
    throw err;
  }
}
'''
text = replace_once(text, "async function validateBeforePublish(post) {", dispatch_jobs + "\nasync function validateBeforePublish(post) {", 'dispatch jobs')

validate_publish = r'''async function validateBeforePublish(post) {
  if (!post) throw new Error('Post não encontrado.');
  const product = post.productId ? await getProduct(post.productId) : null;
  const freshQuality = await qualityGate(post, product);
  if (freshQuality.blockers.length) throw new Error(`Quality Gate bloqueou: ${freshQuality.blockers.join('; ')}`);
  if (!post.mediaKey || !await mediaExists(post.mediaKey)) throw new Error('A mídia interna do post não existe mais; gere/refaça a arte antes de publicar.');
  if (post.origin === 'planner' && boolEnv('REQUIRE_AI_VISUAL', true) && post.visualMode !== 'ai') throw new Error('A arte de IA não foi concluída; publicação automática bloqueada.');
  if (post.plannerType === 'sale') {
    if (!product || !product.active || !product.verified) throw new Error('Produto da venda está inativo, ausente ou não confirmado.');
    if (product.shopeeUrl !== post.shopeeUrl) throw new Error('O link atual do produto mudou; revise o post antes de publicar.');
    if (!productFreshnessState(product, Date.now(), intEnv('PRODUCT_MAX_STALE_DAYS', 14)).fresh) throw new Error('Produto está com verificação de catálogo vencida.');
  }
  if (post.plannerType === 'hype') {
    if (!Array.isArray(post.sources) || !post.sources.length) throw new Error('Hype sem fonte verificável.');
    if (Date.now() - Date.parse(post.hypeCheckedAt || post.createdAt) > intEnv('HYPE_MAX_AGE_HOURS', 4) * 3600_000) throw new Error('Post de hype ficou velho demais; gere um novo assunto.');
  }
  return true;
}
'''
text = sub_once(text, r"async function validateBeforePublish\(post\) \{.*?\n\}\n\nasync function graphGet", validate_publish + "\nasync function graphGet", 'validate publish')

# Review resolution updates product rotation if human confirms publication.
text = replace_once(
    text,
    "  if (updated.dailyDate && updated.plannerType) await markPlanSlot(updated.dailyDate, updated.plannerType, { state: resolution, postId: updated.id, ...(resolution === 'published' ? { publishedAt: updated.publishedAt } : {}) });",
    "  if (resolution === 'published' && updated.productId) await casProduct(updated.productId, p => ({ ...p, lastPostedAt: updated.publishedAt || nowIso(), updatedAt: nowIso() })).catch(() => {});\n  if (updated.dailyDate && updated.plannerType) await markPlanSlot(updated.dailyDate, updated.plannerType, { state: resolution, postId: updated.id, ...(resolution === 'published' ? { publishedAt: updated.publishedAt } : {}) });",
    'review rotation'
)

# Healthy recovery executions when slot already published.
text = replace_once(
    text,
    "  const slot = plan.slots?.[type];\n  if (!slot?.postId) return { type, date, skipped: true, reason: 'slot sem post preparado', state: slot?.state || 'planned' };",
    "  const slot = plan.slots?.[type];\n  if (slot?.state === 'published') return { type, date, published: true, alreadyPublished: true, postId: slot.postId || null };\n  if (!slot?.postId) return { type, date, skipped: true, reason: 'slot sem post preparado', state: slot?.state || 'planned' };",
    'publish recovery state'
)

# Performance snapshots at fixed horizons.
performance_block = r'''async function recomputeProductPerformance(productId) {
  const samples = (await listRecentPosts(POST_INDEX_LIMIT))
    .filter(p => p.status === 'published' && p.productId === productId && p.performance?.windows)
    .slice(0, 12)
    .map(p => {
      const h24 = p.performance.windows.h24?.score;
      const h72 = p.performance.windows.h72?.score;
      if (Number.isFinite(Number(h24))) return Number(h24);
      if (Number.isFinite(Number(h72))) return Number(h72) / 3;
      return null;
    }).filter(v => v != null);
  if (!samples.length) return null;
  const score = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  await casProduct(productId, p => ({ ...p, performanceScore: Number(score.toFixed(2)), performanceSamples: samples.length, performanceUpdatedAt: nowIso(), updatedAt: nowIso() })).catch(() => {});
  return score;
}

function duePerformanceWindow(post, now = Date.now()) {
  const ageHours = (now - Date.parse(post.publishedAt || 0)) / 3600_000;
  const windows = post.performance?.windows || {};
  if (ageHours >= 72 && ageHours <= 14 * 24 && !windows.h72) return 'h72';
  if (ageHours >= 24 && ageHours <= 14 * 24 && !windows.h24) return 'h24';
  return null;
}

async function refreshPostPerformance(post, windowKey) {
  if (!post?.metaPostId || !windowKey) return null;
  const data = await graphGet(post.metaPostId, { fields: 'reactions.limit(0).summary(true),comments.limit(0).summary(true),shares' });
  const reactions = Number(data?.reactions?.summary?.total_count || 0);
  const comments = Number(data?.comments?.summary?.total_count || 0);
  const shares = Number(data?.shares?.count || 0);
  const score = reactions + comments * 4 + shares * 6;
  const snapshot = { reactions, comments, shares, score, checkedAt: nowIso(), window: windowKey };
  const updated = await casPost(post.id, p => {
    const windows = { ...(p.performance?.windows || {}), [windowKey]: snapshot };
    return { ...p, performance: { ...(p.performance || {}), ...snapshot, windows }, updatedAt: nowIso() };
  });
  if (updated.productId) await recomputeProductPerformance(updated.productId);
  return snapshot;
}

export async function refreshRecentPerformance(limit = 6) {
  if (!process.env.META_PAGE_ACCESS_TOKEN) return { refreshed: 0, errors: ['Meta não configurada'] };
  const now = Date.now();
  const candidates = (await listRecentPosts(POST_INDEX_LIMIT))
    .map(post => ({ post, window: duePerformanceWindow(post, now) }))
    .filter(x => x.post.status === 'published' && x.post.metaPostId && x.window)
    .sort((a, b) => String(a.post.publishedAt).localeCompare(String(b.post.publishedAt))).slice(0, limit);
  const results = await Promise.allSettled(candidates.map(x => refreshPostPerformance(x.post, x.window)));
  const refreshed = results.filter(r => r.status === 'fulfilled').length;
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason?.message || 'erro');
  await audit('performance_refresh', { refreshed, errors: errors.length, horizons: candidates.map(x => x.window) });
  return { refreshed, errors };
}
'''
text = sub_once(text, r"async function recomputeProductPerformance\(productId\) \{.*?\n\}\n\nexport function deriveHealthState", performance_block + "\nexport function deriveHealthState", 'performance horizons')

# Health freshness decoration.
health_helper = r'''function decorateHealth(health = {}) {
  const now = Date.now();
  const weekly = new Set(['cleanup-media']);
  return Object.fromEntries(Object.entries(health || {}).map(([name, value]) => {
    const maxAge = weekly.has(name) ? 8 * 86400_000 : 30 * 3600_000;
    const age = value?.at ? now - Date.parse(value.at) : Infinity;
    if (age > maxAge && value?.state !== 'off') return [name, { ...value, state: 'warning', stale: true, staleReason: 'sem execução recente' }];
    return [name, value];
  }));
}
'''
text = replace_once(text, "export async function getDailyPlans() {", health_helper + "\nexport async function getDailyPlans() {", 'health freshness')

# Bootstrap usage/models/health/product count.
text = replace_once(text, "health: health || {}, settings:", "health: decorateHealth(health || {}), settings:", 'decorate health bootstrap')
text = replace_once(text, "usage: usage || { date: today, copy: 0, web: 0, sync: 0, failures: 0 }", "usage: usage || { date: today, copy: 0, web: 0, sync: 0, image: 0, failures: 0 }", 'bootstrap image usage')
text = replace_once(
    text,
    "usageLimits: { copy: intEnv('AI_DAILY_COPY_LIMIT', 8), web: intEnv('AI_DAILY_WEB_LIMIT', 4), sync: intEnv('AI_DAILY_SYNC_LIMIT', 1) },\n      models: { copy: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini', web: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5' }, version: '0.6.0'",
    "usageLimits: { copy: intEnv('AI_DAILY_COPY_LIMIT', 8), web: intEnv('AI_DAILY_WEB_LIMIT', 4), sync: intEnv('AI_DAILY_SYNC_LIMIT', 1), image: intEnv('AI_DAILY_IMAGE_LIMIT', 6) },\n      models: { copy: process.env.OPENAI_COPY_MODEL || 'gpt-5.6-luna', web: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-terra', image: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2' },\n      imageQuality: process.env.OPENAI_IMAGE_QUALITY || 'low', requireAiVisual: boolEnv('REQUIRE_AI_VISUAL', true), autoSyncShopee: boolEnv('AUTO_SYNC_SHOPEE', false), version: '0.7.0'",
    'bootstrap models v07'
)

write(path, text)

# ---------------- API ----------------
path = 'netlify/functions/api.mjs'
text = read(path)
text = replace_once(
    text,
    "  generateManualSale, generateManualType, regeneratePostCreative, patchPost, generatePlan, syncShopeeCatalog, validateMetaConnection,\n  publishById, resolvePostReview, getMedia, refreshRecentPerformance",
    "  queueManualGeneration, queueCreativeGeneration, getJob, regeneratePostCreative, patchPost, generatePlan, syncShopeeCatalog, validateMetaConnection,\n  publishById, resolvePostReview, getMedia, refreshRecentPerformance",
    'api imports'
)
text = sub_once(text, r"    if \(route === '/generate' && method === 'POST'\) \{.*?\n    \}\n\n    if \(route === '/generate/type' && method === 'POST'\) \{.*?\n    \}", r'''    if (route === '/generate' && method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return json(await queueManualGeneration('sale', body.productId), 202);
    }

    if (route === '/generate/type' && method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return json(await queueManualGeneration(body.type, body.productId || null), 202);
    }

    const jobMatch = route.match(/^\/jobs\/([^/]+)$/);
    if (jobMatch && method === 'GET') {
      const job = await getJob(jobMatch[1]);
      return job ? json(job) : json({ error: 'Job não encontrado.' }, 404);
    }''', 'api async generate')
text = replace_once(
    text,
    "    const creativeMatch = route.match(/^\\/posts\\/([^/]+)\\/creative$/);\n    if (creativeMatch && method === 'POST') { const body = await req.json().catch(() => ({})); return json(await regeneratePostCreative(creativeMatch[1], body.mode || 'template')); }",
    "    const creativeMatch = route.match(/^\\/posts\\/([^/]+)\\/creative$/);\n    if (creativeMatch && method === 'POST') { const body = await req.json().catch(() => ({})); if (body.mode === 'ai') return json(await queueCreativeGeneration(creativeMatch[1]), 202); return json(await regeneratePostCreative(creativeMatch[1], body.mode || 'template')); }",
    'api creative AI job'
)
write(path, text)

# ---------------- Scheduled/background functions ----------------
for filename, kind in [('prepare-sale.mjs','sale'), ('prepare-hype.mjs','hype'), ('prepare-growth.mjs','growth')]:
    path = f'netlify/functions/{filename}'
    old = read(path)
    schedule = re.search(r"schedule: '([^']+)'", old).group(1)
    new = f"""import {{ dispatchPrepareDailySlot, recordHealth }} from '../lib/agent.mjs';\nexport default async () => {{\n  try {{ const result = await dispatchPrepareDailySlot('{kind}'); if (result.autoPlan === false) await recordHealth('prepare-{kind}', result); console.log('[prepare-{kind}-dispatch]', JSON.stringify(result)); }}\n  catch (err) {{ await recordHealth('prepare-{kind}', {{ error: err.message }}); console.error('[prepare-{kind}-dispatch]', err); }}\n}};\nexport const config = {{ schedule: '{schedule}' }};\n"""
    write(path, new)

# Publish main + recovery 10 minutes later.
for filename, schedule in [('publish-sale.mjs','0,10 13 * * *'), ('publish-hype.mjs','0,10 18 * * *'), ('publish-growth.mjs','0,10 23 * * *')]:
    p = f'netlify/functions/{filename}'
    t = read(p)
    t = re.sub(r"schedule: '[^']+'", f"schedule: '{schedule}'", t)
    write(p, t)

write('netlify/functions/cleanup-media.mjs', """import { dispatchCleanupMedia, recordHealth } from '../lib/agent.mjs';\nexport default async () => {\n  try { const result = await dispatchCleanupMedia(); console.log('[cleanup-media-dispatch]', JSON.stringify(result)); }\n  catch (err) { await recordHealth('cleanup-media', { error: err.message }); console.error('[cleanup-media-dispatch]', err); }\n};\nexport const config = { schedule: '30 6 * * 0' };\n""")

content_worker = r'''import {
  safeEqual, prepareDailySlot, runGenerationJob, syncShopeeCatalog, cleanupOrphanMedia, recordHealth
} from '../lib/agent.mjs';

function authorized(req) {
  const expected = process.env.WORKER_SECRET || process.env.SESSION_SECRET || '';
  const supplied = req.headers.get('x-animaca-worker-secret') || '';
  return Boolean(expected && supplied && safeEqual(supplied, expected));
}

export default async (req) => {
  if (req.method !== 'POST' || !authorized(req)) return;
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === 'prepare') {
      const result = await prepareDailySlot(body.type, body.date || null);
      await recordHealth(`prepare-${body.type}`, result);
      console.log('[content-worker:prepare]', JSON.stringify({ type: body.type, created: result?.created, state: result?.state }));
      return;
    }
    if (body.action === 'job') {
      const result = await runGenerationJob(body.jobId);
      console.log('[content-worker:job]', JSON.stringify({ jobId: body.jobId, status: result?.status }));
      return;
    }
    if (body.action === 'shopee-sync') {
      const result = await syncShopeeCatalog({ force: false });
      await recordHealth('shopee-sync', result);
      console.log('[content-worker:shopee]', JSON.stringify(result));
      return;
    }
    if (body.action === 'cleanup-media') {
      const result = await cleanupOrphanMedia();
      await recordHealth('cleanup-media', result);
      console.log('[content-worker:cleanup]', JSON.stringify(result));
      return;
    }
    throw new Error('Ação de worker inválida.');
  } catch (err) {
    if (body.action === 'prepare' && body.type) await recordHealth(`prepare-${body.type}`, { error: err.message });
    if (body.action === 'shopee-sync') await recordHealth('shopee-sync', { error: err.message });
    if (body.action === 'cleanup-media') await recordHealth('cleanup-media', { error: err.message });
    console.error('[content-worker]', err);
  }
};

export const config = { background: true };
'''
write('netlify/functions/content-worker.mjs', content_worker)

write('netlify/functions/sync-shopee.mjs', """import { dispatchAutoShopeeSync, recordHealth } from '../lib/agent.mjs';\nexport default async () => {\n  try { const result = await dispatchAutoShopeeSync(); if (result.autoSyncShopee === false) await recordHealth('shopee-sync', result); console.log('[shopee-sync-dispatch]', JSON.stringify(result)); }\n  catch (err) { await recordHealth('shopee-sync', { error: err.message }); console.error('[shopee-sync-dispatch]', err); }\n};\nexport const config = { schedule: '30 11 * * *' };\n""")

# ---------------- frontend ----------------
path = 'public/app.js'
text = read(path)
text = replace_once(text, "failed:'Falhou',off:'Desligado',warning:'Atenção',ok:'Saudável'", "failed:'Falhou',off:'Desligado',warning:'Atenção',ok:'Saudável',stale:'Desatualizado'", 'status stale')

# waitForJob helper after api().
text = replace_once(
    text,
    "function showLogin(){",
    "const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));\nasync function waitForJob(id,timeout=240000){const start=Date.now();while(Date.now()-start<timeout){const job=await api(`/api/jobs/${id}`);if(job.status==='complete')return job;if(job.status==='error')throw new Error(job.error||'A geração em segundo plano falhou.');await sleep(2200)}throw new Error('A geração continua em segundo plano. Atualize a Central em alguns instantes.')}\nfunction showLogin(){",
    'job polling helper'
)

# Accurate Today hero/pending.
text = sub_once(text, r"function renderToday\(\)\{.*?renderAiUsage\(\)\}", r'''function renderToday(){
  const plan=todayPlan();const slots=plan?.slots||{};$('#todayTimeline').innerHTML=['sale','hype','growth'].map(t=>slotCard(t,slots[t])).join('');
  if(!statusState.autoPlan&&!plan){$('#nextActionTitle').textContent='Automação ainda não iniciada';$('#nextActionCopy').textContent='Reserve o plano de hoje ou ative o planejamento quando terminar a homologação.';$('#nextActionTime').textContent='—';$('#nextActionState').outerHTML='<span id="nextActionState" class="status off">Desligado</span>'}
  else if(!plan){$('#nextActionTitle').textContent='Reserve o plano de hoje';$('#nextActionCopy').textContent='Nenhum slot foi reservado ainda. Reservar o plano não gasta IA.';$('#nextActionTime').textContent='—';$('#nextActionState').outerHTML='<span id="nextActionState" class="status warning">Ação necessária</span>'}
  else{const now=Date.now();const candidates=['sale','hype','growth'].map(t=>{const s=slots[t]||{};const at=s.scheduledAt?Date.parse(s.scheduledAt):Date.parse(`${localDate()}T${typeTime[t]}:00-03:00`);return{t,s,at}}).filter(x=>!['published','cancelled','expired'].includes(x.s.state||'')&&x.at>now-5*60_000).sort((a,b)=>a.at-b.at);const next=candidates[0];if(next){$('#nextActionTitle').textContent=`${typeLabel[next.t]} das ${typeTime[next.t].replace(':00','h')}`;$('#nextActionCopy').textContent=next.s.postId?'O conteúdo já foi preparado. Revise o Quality Gate antes da publicação.':'O worker vai preparar conteúdo, pesquisa e arte perto do horário.';$('#nextActionTime').textContent=dateBR(new Date(next.at).toISOString(),{timeOnly:true});$('#nextActionState').outerHTML=badgeStatus(next.s.state||'planned').replace('<span','<span id="nextActionState"')}else{$('#nextActionTitle').textContent='Agenda de hoje concluída';$('#nextActionCopy').textContent='Não há mais slots pendentes para hoje.';$('#nextActionTime').textContent='✓';$('#nextActionState').outerHTML='<span id="nextActionState" class="status published">Concluído</span>'}}
  const attentionAll=state.posts.filter(p=>['draft','error','needs_review'].includes(p.status)||(!statusState.autoPublish&&p.status==='approved'));const attention=attentionAll.slice(0,4);$('#pendingCount').textContent=attentionAll.length;$('#attentionPosts').innerHTML=attention.length?attention.map(p=>`<button class="attention-item" data-open-post="${esc(p.id)}"><span><strong>${esc(p.productName||p.topic||typeLabel[p.plannerType]||'Post')}</strong><span>${esc(typeLabel[p.plannerType]||'Manual')} · ${esc(statusLabel[p.status]||p.status)}</span></span><b>Revisar →</b></button>`).join(''):'<div class="empty-state"><b>Nada pendente agora</b>A fila está limpa.</div>';renderAiUsage()}
''', 'renderToday')

text = replace_once(
    text,
    "const rows=[['Copy',u.copy||0,l.copy],['Pesquisa web',u.web||0,l.web],['Shopee',u.sync||0,l.sync]];",
    "const rows=[['Copy',u.copy||0,l.copy],['Pesquisa web',u.web||0,l.web],['Imagens IA',u.image||0,l.image],['Shopee',u.sync||0,l.sync]];",
    'image usage UI'
)
text = replace_once(
    text,
    "Modelos: copy ${esc(statusState.models?.copy||'—')} · web ${esc(statusState.models?.web||'—')} · falhas hoje",
    "Modelos: copy ${esc(statusState.models?.copy||'—')} · web ${esc(statusState.models?.web||'—')} · imagem ${esc(statusState.models?.image||'—')} (${esc(statusState.imageQuality||'—')}) · falhas hoje",
    'models image UI'
)

# Product stale UI.
text = replace_once(
    text,
    "const ready=productReady(p);const photo=imageFor(p);return `<article",
    "const ready=productReady(p)&&p.catalogFresh!==false;const photo=imageFor(p);return `<article",
    'product ready freshness UI'
)
text = replace_once(text, "'Sem link Shopee'}</div><div class=\"product-score\">", "'Sem link Shopee'}</div>${p.catalogFresh===false?'<div class=\"product-info stale-text\">Catálogo desatualizado — sincronize a Shopee</div>':''}<div class=\"product-score\">", 'product stale line')

# Evidence and visual badges in post cards.
text = replace_once(
    text,
    "${p.plannerType==='sale'&&p.shopeeUrl?`<div class=\"det-link\">🛒 Link inserido pelo servidor: ${esc(p.shopeeUrl)}</div>`:''}${qualityHtml(p)}",
    "${p.plannerType==='sale'&&p.shopeeUrl?`<div class=\"det-link\">🛒 Link inserido pelo servidor: ${esc(p.shopeeUrl)}</div>`:''}${p.sources?.length?`<div class=\"evidence-box\"><b>Fontes do hype</b>${p.sources.slice(0,3).map(s=>`<a href=\"${esc(s.url)}\" target=\"_blank\" rel=\"noreferrer\">${esc(s.domain||s.title||'Fonte')} ↗</a>`).join('')}</div>`:''}<div class=\"visual-line\">Visual: <b>${p.visualMode==='ai'?'GPT Image 2 + composição real':p.generatedVisual?'Template local':'Foto original'}</b>${p.visualAiError?' · fallback usado':''}</div>${qualityHtml(p)}",
    'post evidence visual'
)
text = text.replace("data-post-action=\"regen\" data-id=\"${esc(p.id)}\">Refazer arte</button>", "data-post-action=\"regen\" data-id=\"${esc(p.id)}\">Novo layout</button><button class=\"btn secondary\" data-post-action=\"regen-ai\" data-id=\"${esc(p.id)}\">Criar arte com IA</button>")

# Async manual generation listener.
text = sub_once(text, r"\$\$\('\[data-test-content\]'\)\.forEach\(b=>b\.addEventListener\('click',async\(\)=>\{.*?\}\)\);", r'''$$('[data-test-content]').forEach(b=>b.addEventListener('click',async()=>{const type=b.dataset.testContent;const productId=type==='sale'?$('#productSelect').value:null;if(type==='sale'&&!productId)return toast('Nenhum produto pronto para venda.');try{b.disabled=true;toast('Gerando copy e arte com IA em segundo plano…');const job=await api('/api/generate/type',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,productId})});await waitForJob(job.id);toast(`${typeLabel[type]} criado como rascunho.`);await load();setView('content')}catch(e){toast(e.message)}finally{b.disabled=false}}));''', 'manual async UI')

# AI regenerate action.
text = replace_once(
    text,
    "else if(b.dataset.postAction==='regen'){await api(`/api/posts/${id}/creative`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'template'})});toast('Nova variação visual criada.')}else if(b.dataset.postAction==='original')",
    "else if(b.dataset.postAction==='regen'){await api(`/api/posts/${id}/creative`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'template'})});toast('Novo layout local criado.')}else if(b.dataset.postAction==='regen-ai'){toast('Gerando nova arte com GPT Image 2…');const job=await api(`/api/posts/${id}/creative`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'ai'})});await waitForJob(job.id);toast('Nova arte de IA criada.')}else if(b.dataset.postAction==='original')",
    'regen AI UI'
)

# System shows image/autosync.
text = replace_once(
    text,
    "Copy: ${esc(statusState.models?.copy||'—')} · Web: ${esc(statusState.models?.web||'—')}`}",
    "Copy: ${esc(statusState.models?.copy||'—')} · Web: ${esc(statusState.models?.web||'—')}<br>Imagem: ${esc(statusState.models?.image||'—')} (${esc(statusState.imageQuality||'—')}) · Visual IA obrigatório: ${statusState.requireAiVisual?'sim':'não'} · Auto-sync Shopee: ${statusState.autoSyncShopee?'ligado':'desligado'}`}",
    'system image info'
)
write(path, text)

# CSS: preserve critical mobile status, larger operational type, evidence.
path = 'public/app.css'
text = read(path)
text = text.replace('.muted{color:var(--muted);font-size:13px;', '.muted{color:var(--muted);font-size:14px;')
text = text.replace('.slot-card p{color:var(--muted);font-size:12px;', '.slot-card p{color:var(--muted);font-size:13px;')
text = text.replace('.btn{border:1px solid transparent;border-radius:12px;padding:9px 13px;font-weight:850;font-size:12px;', '.btn{border:1px solid transparent;border-radius:12px;padding:9px 13px;font-weight:850;font-size:13px;')
text = text.replace('.status{display:inline-flex;align-items:center;width:max-content;border:1px solid var(--line);border-radius:999px;padding:5px 8px;font-size:10px;', '.status{display:inline-flex;align-items:center;width:max-content;border:1px solid var(--line);border-radius:999px;padding:5px 8px;font-size:11px;')
text = text.replace('.post-meta{margin-top:10px;color:var(--muted);font-size:10px}', '.post-meta{margin-top:10px;color:var(--muted);font-size:11px}')
text += "\n.evidence-box{margin-top:10px;padding:11px 12px;border:1px solid #29415f;background:#0a1421;border-radius:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px}.evidence-box b{width:100%;color:#b9c8dc}.evidence-box a{border:1px solid #314965;border-radius:999px;padding:5px 8px;text-decoration:none}.visual-line{margin-top:10px;color:#9fb0c7;font-size:11px}.visual-line b{color:#d7e1ed}.stale-text{color:#fbbf24!important}\n"
text = text.replace('@media(max-width:920px){.app-shell{grid-template-columns:1fr}.sidebar{position:fixed;left:0;transform:translateX(-104%);transition:.2s ease;width:250px;box-shadow:20px 0 70px #0009}.mobile-menu{display:block}.topbar{height:82px}.topbar>div:nth-child(2){margin-right:auto;margin-left:10px}.topbar .connection-pill{display:none}', '@media(max-width:920px){.app-shell{grid-template-columns:1fr}.sidebar{position:fixed;left:0;transform:translateX(-104%);transition:.2s ease;width:250px;box-shadow:20px 0 70px #0009}.mobile-menu{display:block}.topbar{height:82px}.topbar>div:nth-child(2){margin-right:auto;margin-left:10px}.topbar .connection-pill{display:flex;padding:7px 9px;font-size:11px}')
text = text.replace('@media(max-width:620px){.topbar{padding:14px 15px}.topbar h1{font-size:21px}.top-actions .btn{display:none}', '@media(max-width:620px){.topbar{padding:14px 15px}.topbar h1{font-size:21px}.top-actions{gap:5px}.top-actions .btn{display:inline-flex;padding:7px 8px}.connection-pill{padding:7px}.connection-pill span:last-child{font-size:0}.connection-pill span:last-child:after{content:"IA/Meta";font-size:10px}')
write(path, text)

# HTML version.
path = 'public/index.html'
text = read(path).replace('Central v0.6', 'Central v0.7').replace('<span class="version-chip">v0.6</span>', '<span class="version-chip">v0.7</span>')
write(path, text)

# env / package / docs.
path = '.env.example'
text = read(path)
text = text.replace('OPENAI_MODEL=gpt-5\nOPENAI_COPY_MODEL=gpt-5-mini\nOPENAI_WEB_MODEL=gpt-5\n', 'OPENAI_MODEL=gpt-5.6-terra\nOPENAI_COPY_MODEL=gpt-5.6-luna\nOPENAI_WEB_MODEL=gpt-5.6-terra\nOPENAI_IMAGE_MODEL=gpt-image-2\nOPENAI_IMAGE_QUALITY=low\n')
text = text.replace('TIMEZONE=America/Sao_Paulo\n', '')
text = text.replace('AUTO_PUBLISH=false\n', 'AUTO_PUBLISH=false\nAUTO_SYNC_SHOPEE=false\nREQUIRE_AI_VISUAL=true\n')
text = text.replace('AI_DAILY_SYNC_LIMIT=1\n', 'AI_DAILY_SYNC_LIMIT=1\nAI_DAILY_IMAGE_LIMIT=6\n')
text += 'PRODUCT_MAX_STALE_DAYS=14\nHYPE_MAX_AGE_HOURS=4\n'
write(path, text)

path = 'package.json'
text = read(path).replace('"version": "0.6.0"', '"version": "0.7.0"')
text = text.replace('node --check public/app.js && node --check netlify/lib/agent.mjs && node --check netlify/functions/api.mjs && for f in netlify/functions/*.mjs; do node --check "$f"; done', 'node --check public/app.js && for f in netlify/lib/*.mjs netlify/functions/*.mjs; do node --check "$f"; done')
write(path, text)

path = 'package-lock.json'
text = read(path).replace('"version": "0.6.0"', '"version": "0.7.0"', 2)
write(path, text)

readme = '''# Animaca Geek Facebook Agent v0.7\n\nAgente serverless para Netlify com três frentes diárias: **Venda Shopee → Hype do momento → Crescimento**. A v0.7 transforma o antigo “Creative Engine” de template em um pipeline visual real: **GPT Image 2 gera o cenário; Sharp compõe a foto real do produto, tipografia e marca**.\n\n## Arquitetura v0.7\n\n- Scheduled Functions ficam leves e apenas disparam trabalho.\n- `content-worker` é Background Function para copy, web search e geração de imagem, evitando o limite de 30 s do scheduler.\n- Publicação Meta continua em função curta, com execução principal e recovery 10 minutos depois.\n- Jobs manuais também usam o worker e o painel acompanha até concluir.\n\n## Segurança visual e comercial\n\n- Venda nunca pede para a IA inventar o produto: o GPT Image 2 gera somente o fundo/cenário; a foto real cadastrada é composta por cima.\n- Imagens por URL são baixadas, validadas e internalizadas no Netlify Blobs.\n- Post automático só publica se a mídia interna ainda existir.\n- Copy não pode carregar URL; o link Shopee continua sendo acrescentado deterministicamente pelo servidor.\n- Hype guarda evidências da busca web e passa por filtro local + `omni-moderation-latest`.\n- Quality Gate com blocker nunca pode aparecer como 100/100.\n\n## Loja Shopee\n\n- `AUTO_SYNC_SHOPEE=true` habilita uma busca diária às 08:30 BRT em Background Function.\n- Produtos não encontrados repetidamente ficam `stale` e saem da rotação automática.\n- Itens novos encontrados continuam exigindo confirmação humana e foto real antes de vender.\n\n## Horários\n\n- 09:15/09:35 BRT: prepara venda.\n- 10:00 + recovery 10:10: publica venda.\n- 14:15/14:35: prepara hype.\n- 15:00 + recovery 15:10: publica hype.\n- 19:15/19:35: prepara crescimento.\n- 20:00 + recovery 20:10: publica crescimento.\n- 03:00: métricas com snapshots de 24 h e 72 h.\n- 08:30: sync Shopee opcional.\n- domingo 03:30: limpeza em background.\n\n## Homologação\n\nMantenha inicialmente:\n\n```env\nAUTO_PLAN=false\nAUTO_APPROVE_PLANNER=false\nAUTO_PUBLISH=false\nAUTO_SYNC_SHOPEE=false\nREQUIRE_AI_VISUAL=true\n```\n\nTeste manualmente Venda, Hype e Crescimento. Depois ligue `AUTO_PLAN`, em seguida `AUTO_SYNC_SHOPEE`, depois aprovação automática e por último publicação automática.\n\nNunca coloque tokens ou chaves no GitHub.\n'''
write('README.md', readme)

changelog = read('CHANGELOG.md')
if '## v0.7.0' not in changelog:
    changelog = '# Changelog\n\n## v0.7.0\n- GPT Image 2 gera fundos/visuais reais; venda preserva a foto real do produto.\n- Geração pesada migra para Background Function; Scheduled Functions viram dispatchers.\n- Jobs manuais assíncronos com polling no painel.\n- Imagem externa é validada e internalizada; mídia é revalidada antes de publicar.\n- Hype guarda fontes/evidências e usa moderação + filtros de brand safety.\n- Catálogo ganha frescor/stale, deduplicação no mesmo sync e auto-sync opcional.\n- Quality Gate limita score quando há blocker e bloqueia URL na copy.\n- Publicação recebe recovery de 10 minutos.\n- Performance é comparada em janelas fixas de 24 h e 72 h.\n- Índice de produtos elimina scans completos rotineiros.\n- Mobile mantém IA/Meta/Atualizar visíveis e aumenta legibilidade.\n\n' + changelog.split('# Changelog\n',1)[1].lstrip()
write('CHANGELOG.md', changelog)

# Stronger tests.
tests = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { copyHasUrl, stripUrls, sensitiveReasons, buildImagePrompt, extractWebEvidence } from '../netlify/lib/creative-ai.mjs';
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

test('produto fica stale por idade ou duas ausências de sync', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');
  const base = { shopeeUrl: 'https://shopee.com.br/x', verified: true, verifiedAt: '2026-08-15T12:00:00Z' };
  assert.equal(productFreshnessState(base, now, 14).fresh, true);
  assert.equal(productFreshnessState({ ...base, missingSyncCount: 2 }, now, 14).fresh, false);
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
'''
write('tests/v07.test.mjs', tests)

print('v0.7 patch applied')
