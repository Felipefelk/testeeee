from pathlib import Path
import re

ROOT = Path('.')
agent_path = ROOT / 'netlify/lib/agent.mjs'
api_path = ROOT / 'netlify/functions/api.mjs'
agent = agent_path.read_text()
api = api_path.read_text()

def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'Não encontrei trecho: {label}')
    if text.count(old) != 1:
        raise SystemExit(f'Trecho não único ({text.count(old)}): {label}')
    return text.replace(old, new, 1)

def replace_between(text, start, end, new_block, label):
    i = text.find(start)
    if i < 0:
        raise SystemExit(f'Início não encontrado: {label}')
    j = text.find(end, i)
    if j < 0:
        raise SystemExit(f'Fim não encontrado: {label}')
    return text[:i] + new_block.rstrip() + '\n\n' + text[j:]

# 1) Imports de rede para SSRF protection.
agent = replace_once(agent,
"import crypto from 'node:crypto';",
"import crypto from 'node:crypto';\nimport dns from 'node:dns/promises';\nimport net from 'node:net';",
'imports rede')

# 2) Helpers de URL segura + Shopee curta/canônica.
marker = "const parseBooleanInput = value => {"
helpers = r'''
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

'''
if helpers.strip() not in agent:
    agent = agent.replace(marker, helpers + marker, 1)

# 3) Cadastro: resolve shortlink + rejeita URL duplicada.
agent = replace_once(agent,
"  const link = canonicalizeShopeeUrl(shopeeUrl);\n  const now = nowIso();",
"  const link = await normalizeShopeeUrl(shopeeUrl);\n  if (link) {\n    const duplicate = (await listProducts()).find(p => p.shopeeUrl === link);\n    if (duplicate) { const e = new Error(`Este link da Shopee já pertence ao produto “${duplicate.name}”.`); e.status = 409; throw e; }\n  }\n  const now = nowIso();",
'createProduct URL')

# 4) Editar produto só invalida confirmação se link realmente mudou.
old_update = '''export async function updateProduct(id, body) {
  const updated = await casProduct(id, current => {
    if ('name' in body) { const n = String(body.name || '').trim(); if (!n) throw new Error('Nome é obrigatório.'); current.name = n; }
    if ('category' in body) current.category = String(body.category || '').trim();
    if ('price' in body) current.price = String(body.price || '').trim();
    if ('description' in body) current.description = String(body.description || '').trim();
    if ('imageUrl' in body) current.imageUrl = validateHttpsUrl(body.imageUrl);
    if ('shopeeUrl' in body) { current.shopeeUrl = canonicalizeShopeeUrl(body.shopeeUrl); current.verified = false; current.verifiedAt = null; }
    if ('active' in body) current.active = parseBooleanInput(body.active);
    current.updatedAt = nowIso();
    return current;
  });
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}'''
new_update = '''export async function updateProduct(id, body) {
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
}'''
agent = replace_once(agent, old_update, new_update, 'updateProduct')

# 5) Sync Shopee também normaliza shortlinks.
agent = replace_once(agent,
"      const url = canonicalizeShopeeUrl(item.url);",
"      const url = await normalizeShopeeUrl(item.url);",
'sync shopee normalize')

# 6) Fetch de imagem externa com proteção SSRF e limite por streaming.
start = "async function productImageBuffer(product) {"
end = "async function createCreative({ type, message, topic, product }) {"
new_product_image = r'''async function productImageBuffer(product) {
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

'''
agent = replace_between(agent, start, end, new_product_image, 'productImageBuffer')

# 7) Creative Engine v2: branco, 6 variações, sem assinatura de automação.
start = "async function createCreative({ type, message, topic, product }) {"
end = "export function textSimilarity(a, b) {"
creative_v2 = r'''function approxTextWidth(text, fontSize) {
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

'''
agent = replace_between(agent, start, end, creative_v2, 'creative engine')

# 8) Quality Gate inclui visual automático.
agent = replace_once(agent,
"  if (post.plannerType === 'growth' && !msg.includes('?')) { score -= 10; warnings.push('post de crescimento sem pergunta clara'); }\n  score = Math.max(0, score);",
"  if (post.plannerType === 'growth' && !msg.includes('?')) { score -= 10; warnings.push('post de crescimento sem pergunta clara'); }\n  if (post.origin === 'planner' && !post.mediaKey && !post.imageUrl) blockers.push('post automático sem arte visual');\n  score = Math.max(0, score);",
'quality visual')

# 9) Só escolhe produto com foto e só considera vendas realmente publicadas na rotação.
agent = replace_once(agent,
"  const products = (await listProducts()).filter(p => p.active && p.verified && p.shopeeUrl);",
"  const products = (await listProducts()).filter(p => p.active && p.verified && p.shopeeUrl && (p.mediaKey || p.imageUrl));",
'chooseSale photo')
agent = replace_once(agent,
"  const recentIds = new Set(recent.filter(p => p.plannerType === 'sale' && p.productId).slice(0, 5).map(p => p.productId));",
"  const recentIds = new Set(recent.filter(p => p.status === 'published' && p.plannerType === 'sale' && p.productId).slice(0, 5).map(p => p.productId));",
'rotation published')
agent = replace_once(agent,
"  if (!products.length) throw new Error('Nenhum produto confirmado e ativo tem link da Shopee.');",
"  if (!products.length) throw new Error('Nenhum produto pronto para venda: precisa estar ativo, confirmado, com link Shopee e foto real.');",
'chooseSale error')

# 10) Stale publishing lock nunca republica automaticamente.
stale_old = '''    if (row.status === 'publishing') {
      const age = Date.now() - Date.parse(row.publishLockAt || 0);
      if (age < PUBLISH_LOCK_MS) { const e = new Error('Este post já está em processo de publicação.'); e.status = 409; throw e; }
    }
    if (!['approved', 'publishing'].includes(row.status)) { const e = new Error('Apenas posts aprovados podem ser publicados.'); e.status = 409; throw e; }'''
stale_new = '''    if (row.status === 'publishing') {
      const age = Date.now() - Date.parse(row.publishLockAt || 0);
      if (age < PUBLISH_LOCK_MS) { const e = new Error('Este post já está em processo de publicação.'); e.status = 409; throw e; }
      const review = { ...row, status: 'needs_review', error: 'A tentativa anterior ficou sem confirmação final. Verifique o Facebook antes de qualquer nova publicação.', publishToken: null, publishLockAt: null, updatedAt: nowIso() };
      const moved = await store.setJSON(`post/${id}`, review, { onlyIfMatch: entry.etag });
      if (moved.modified) await indexPost(review).catch(() => {});
      const e = new Error('Publicação anterior com resultado incerto. O post foi enviado para revisão manual para evitar duplicação.'); e.status = 409; e.ambiguous = true; throw e;
    }
    if (row.status !== 'approved') { const e = new Error('Apenas posts aprovados podem ser publicados.'); e.status = 409; throw e; }'''
agent = replace_once(agent, stale_old, stale_new, 'stale publishing')

# 11) HTTP 5xx/408 da Meta = ambíguo.
agent = replace_once(agent,
"  if (!response.ok) { const e = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`); e.code = json?.error?.code; e.subcode = json?.error?.error_subcode; throw e; }\n  return json;\n}\n\nasync function publishPost(post) {",
"  if (!response.ok) { const e = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`); e.code = json?.error?.code; e.subcode = json?.error?.error_subcode; if (response.status >= 500 || response.status === 408) e.ambiguous = true; throw e; }\n  return json;\n}\n\nasync function publishPost(post) {",
'graphPost ambiguous')

# 12) Performance idempotente e amostragem rotativa.
start = "async function refreshPostPerformance(post) {"
end = "async function audit(type, data = {}) {"
performance_v2 = r'''async function recomputeProductPerformance(productId) {
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

'''
agent = replace_between(agent, start, end, performance_v2, 'performance')

# 13) Health sem falso verde.
agent = replace_once(agent,
"export async function recordHealth(name, result) {\n  return mutateSystemJson('health', {}, health => {\n    health[name] = { at: nowIso(), ok: !result?.error, result };\n    return health;\n  });\n}",
"export async function recordHealth(name, result) {\n  return mutateSystemJson('health', {}, health => {\n    const state = deriveHealthState(result);\n    health[name] = { at: nowIso(), state, ok: state === 'ok', result };\n    return health;\n  });\n}",
'health semantic')

# 14) Testar hype/growth agora + refazer/trocar arte de post.
insert_before = "export async function patchPost(id, body) {"
manual_funcs = r'''export async function generateManualType(type, productId = null) {
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

'''
if manual_funcs.strip() not in agent:
    agent = agent.replace(insert_before, manual_funcs + insert_before, 1)

# 15) Media GC semanal.
insert_before = "export async function statusSummary() {"
gc_func = r'''export async function cleanupOrphanMedia({ minAgeDays = 14, limit = 80 } = {}) {
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

'''
if gc_func.strip() not in agent:
    agent = agent.replace(insert_before, gc_func + insert_before, 1)

# 16) Bootstrap expõe limites/modelos para UX de eficiência.
agent = replace_once(agent,
"      counts: { products: products.length, posts: Number(idx.totalPosts || posts.length), pending }, usage: usage || { date: today, copy: 0, web: 0, sync: 0, failures: 0 }",
"      counts: { products: products.length, posts: Number(idx.totalPosts || posts.length), pending }, usage: usage || { date: today, copy: 0, web: 0, sync: 0, failures: 0 },\n      usageLimits: { copy: intEnv('AI_DAILY_COPY_LIMIT', 8), web: intEnv('AI_DAILY_WEB_LIMIT', 4), sync: intEnv('AI_DAILY_SYNC_LIMIT', 1) },\n      models: { copy: process.env.OPENAI_COPY_MODEL || 'gpt-5-mini', web: process.env.OPENAI_WEB_MODEL || process.env.OPENAI_MODEL || 'gpt-5' }, version: '0.6.0'",
'bootstrap usage')

# 17) API: novas funções e rotas.
api = replace_once(api,
"  generateManualSale, patchPost, generatePlan, syncShopeeCatalog, validateMetaConnection,\n  publishById, getMedia, refreshRecentPerformance",
"  generateManualSale, generateManualType, regeneratePostCreative, patchPost, generatePlan, syncShopeeCatalog, validateMetaConnection,\n  publishById, getMedia, refreshRecentPerformance",
'api imports')
api = replace_once(api,
"    if (route === '/generate' && method === 'POST') {\n      const body = await req.json().catch(() => ({}));\n      return json(await generateManualSale(body.productId));\n    }",
"    if (route === '/generate' && method === 'POST') {\n      const body = await req.json().catch(() => ({}));\n      return json(await generateManualSale(body.productId));\n    }\n\n    if (route === '/generate/type' && method === 'POST') {\n      const body = await req.json().catch(() => ({}));\n      return json(await generateManualType(body.type, body.productId || null));\n    }",
'api generate type')
api = replace_once(api,
"    const pubMatch = route.match(/^\\/posts\\/([^/]+)\\/publish$/);\n    if (pubMatch && method === 'POST') return json(await publishById(pubMatch[1]));",
"    const creativeMatch = route.match(/^\\/posts\\/([^/]+)\\/creative$/);\n    if (creativeMatch && method === 'POST') { const body = await req.json().catch(() => ({})); return json(await regeneratePostCreative(creativeMatch[1], body.mode || 'template')); }\n\n    const pubMatch = route.match(/^\\/posts\\/([^/]+)\\/publish$/);\n    if (pubMatch && method === 'POST') return json(await publishById(pubMatch[1]));",
'api creative')

agent_path.write_text(agent)
api_path.write_text(api)

# 18) Scheduled GC.
(ROOT / 'netlify/functions/cleanup-media.mjs').write_text("""import { cleanupOrphanMedia, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await cleanupOrphanMedia(); await recordHealth('cleanup-media', result); console.log('[cleanup-media]', JSON.stringify(result)); }
  catch (err) { await recordHealth('cleanup-media', { error: err.message }); console.error('[cleanup-media]', err); }
};
export const config = { schedule: '30 6 * * 0' };
""")

# 19) Testes novos de helpers puros.
test_path = ROOT / 'tests/agent.test.mjs'
test = test_path.read_text()
test = test.replace(
"import { buildFinalMessage, textSimilarity, plannerSlots, canonicalizeShopeeUrl } from '../netlify/lib/agent.mjs';",
"import { buildFinalMessage, textSimilarity, plannerSlots, canonicalizeShopeeUrl, isPrivateAddress, deriveHealthState } from '../netlify/lib/agent.mjs';"
)
append = r'''

test('endereços privados são bloqueados', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.0.0.8'), true);
  assert.equal(isPrivateAddress('192.168.1.3'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('health distingue desligado de saudável', () => {
  assert.equal(deriveHealthState({ autoPlan: false }), 'off');
  assert.equal(deriveHealthState({ skipped: true }), 'warning');
  assert.equal(deriveHealthState({ error: 'x' }), 'error');
  assert.equal(deriveHealthState({ ok: true }), 'ok');
});
'''
if "health distingue desligado" not in test:
    test += append
test_path.write_text(test)

# 20) Versão.
pkg = ROOT / 'package.json'
p = pkg.read_text().replace('"version": "0.5.0"', '"version": "0.6.0"')
pkg.write_text(p)

print('backend v0.6 aplicado')
