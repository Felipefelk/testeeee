from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]

def read(path): return (ROOT / path).read_text(encoding='utf-8')
def write(path, text): (ROOT / path).write_text(text, encoding='utf-8')
def rep(text, old, new, label):
    if old not in text: raise RuntimeError(f'[{label}] trecho não encontrado')
    return text.replace(old, new, 1)
def sub(text, pattern, repl, label, flags=re.S):
    out, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n != 1: raise RuntimeError(f'[{label}] esperado 1 match, obtido {n}')
    return out

# ---------------- agent hardening ----------------
p='netlify/lib/agent.mjs'; t=read(p)

# Catálogo via web search é sinal, não autoridade: ausência gera atenção; só idade bloqueia.
t=rep(t,
"  const missing = Number(p.missingSyncCount || 0);\n  const fresh = ageDays <= maxDays && missing < 2;\n  return { fresh, state: fresh ? (missing ? 'attention' : 'fresh') : 'stale', ageDays: Number(ageDays.toFixed(1)) };",
"  const missing = Number(p.missingSyncCount || 0);\n  const fresh = ageDays <= maxDays;\n  return { fresh, state: fresh ? (missing ? 'attention' : 'fresh') : 'stale', ageDays: Number(ageDays.toFixed(1)), missingSyncCount: missing };",
'freshness search not authority')

# Confirmação exige mídia internalizada e existente.
t=sub(t, r"export async function confirmProduct\(id\) \{.*?\n\}\n\nexport async function deleteProduct", r'''export async function confirmProduct(id) {
  const current = await getProduct(id);
  if (!current) throw new Error('Produto não encontrado.');
  if (!current.shopeeUrl) throw new Error('Produto sem link específico da Shopee.');
  if (!current.mediaKey || !await mediaExists(current.mediaKey)) throw new Error('Adicione uma foto real válida e internalizada antes de confirmar o produto.');
  const updated = await casProduct(id, p => ({
    ...p,
    price: p.price || p.observedPrice || '', active: true, verified: true, verifiedAt: nowIso(), lastCatalogCheckAt: nowIso(), missingSyncCount: 0, catalogStatus: 'confirmed', imageUrl: '', updatedAt: nowIso()
  }));
  if (!updated) throw new Error('Produto não encontrado.');
  return updated;
}

export async function deleteProduct''', 'confirmProduct')

# Growth digest compara janelas em base aproximadamente comum.
t=sub(t, r"async function performanceDigest\(limit = 6\) \{.*?\n\}\n\nasync function catalogDigest", r'''async function performanceDigest(limit = 6) {
  const rows = (await listRecentPosts(80)).filter(p => p.status === 'published' && p.performance)
    .map(p => {
      const h24 = Number(p.performance?.windows?.h24?.score);
      const h72 = Number(p.performance?.windows?.h72?.score);
      const normalized = Number.isFinite(h24) ? h24 : Number.isFinite(h72) ? h72 / 3 : Number(p.performance?.score || 0);
      return { ...p, normalizedPerformance: normalized };
    })
    .sort((a, b) => b.normalizedPerformance - a.normalizedPerformance).slice(0, limit);
  if (!rows.length) return 'Ainda sem histórico suficiente de performance.';
  return rows.map(p => `${p.plannerType || 'post'} | ${p.topic || p.productName || 'tema'} | score normalizado ${Number(p.normalizedPerformance || 0).toFixed(1)}`).join('\n');
}

async function catalogDigest''', 'performance digest')

# Geração visual: qualidade smart, contabiliza falhas de imagem.
t=sub(t, r"async function createAiCreative\(\{ type, message, topic, product, salt = '' \}\) \{.*?\n\}\n\nasync function assessTextSafety", r'''async function createAiCreative({ type, message, topic, product, salt = '' }) {
  await consumeAiBudget('image');
  const prompt = buildImagePrompt({ type, topic, category: product?.category || '' });
  const configured = String(process.env.OPENAI_IMAGE_QUALITY || 'smart').toLowerCase();
  const quality = configured === 'smart' ? (type === 'sale' ? 'low' : 'medium') : configured;
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('OPENAI_IMAGE_QUALITY inválida. Use smart, low, medium, high ou auto.');
  try {
    const generated = await generateImageBuffer({
      apiKey: process.env.OPENAI_API_KEY,
      prompt,
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
      quality,
      size: '1024x1024'
    });
    const backgroundBuffer = await sharp(generated.buffer, { failOn: 'error' }).rotate().resize(1080, 1080, { fit: 'cover' }).webp({ quality: 92 }).toBuffer();
    return createCreative({ type, message, topic, product, salt, backgroundBuffer, visualSource: 'openai-image', aiModel: generated.model });
  } catch (err) {
    await markAiFailure();
    throw err;
  }
}

async function assessTextSafety''', 'AI creative failure/quality')

# Texto longo sem espaços não pode estourar arte.
t=sub(t, r"function wrapTextPx\(text, maxWidth, fontSize, maxLines = 4\) \{.*?\n\}\n\nfunction creativeVariant", r'''function trimWordPx(word, maxWidth, fontSize) {
  if (approxTextWidth(word, fontSize) <= maxWidth) return word;
  let out = '';
  for (const ch of String(word || '')) {
    if (approxTextWidth(`${out}${ch}…`, fontSize) > maxWidth) break;
    out += ch;
  }
  return `${out || String(word || '').slice(0, 1)}…`;
}

function wrapTextPx(text, maxWidth, fontSize, maxLines = 4) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(w => trimWordPx(w, maxWidth, fontSize));
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && approxTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(line); line = word;
      if (lines.length >= maxLines - 1) break;
    } else line = candidate;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(' ').length > lines.join(' ').length && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/[.…]*$/, '') + '…';
  return lines;
}

function creativeVariant''', 'long-word visual fit')

# Painel branco translúcido garante contraste sobre fundo gerado.
t=rep(t,
"  const textSvg = `<svg width=\"1080\" height=\"1080\" xmlns=\"http://www.w3.org/2000/svg\">\n    <rect x=\"92\" y=\"88\" width=\"${Math.min(650, 40 + approxTextWidth(label, 25))}\" height=\"50\" rx=\"25\" fill=\"${accent}\"/>",
"  const panelY = Math.max(160, titleY - titleSize - 38);\n  const panelH = Math.min(760, titleLines.length * Math.round(titleSize * 1.12) + subLines.length * 44 + 125);\n  const panelX = Math.max(60, titleX - 28);\n  const panelW = Math.min(960 - panelX, titleWidth + 56);\n  const textSvg = `<svg width=\"1080\" height=\"1080\" xmlns=\"http://www.w3.org/2000/svg\">\n    ${backgroundBuffer ? `<rect x=\"${panelX}\" y=\"${panelY}\" width=\"${panelW}\" height=\"${panelH}\" rx=\"30\" fill=\"#ffffff\" fill-opacity=\"0.86\"/>` : ''}\n    <rect x=\"92\" y=\"88\" width=\"${Math.min(650, 40 + approxTextWidth(label, 25))}\" height=\"50\" rx=\"25\" fill=\"${accent}\"/>",
'AI text contrast')

# Quality: produto também precisa de blob real; moderação ausente impede só autoaprovação, não revisão humana.
t=rep(t,
"    if (!product?.mediaKey) blockers.push('produto sem foto real interna validada');",
"    if (!product?.mediaKey) blockers.push('produto sem foto real interna validada');\n    else if (!await mediaExists(product.mediaKey)) blockers.push('arquivo da foto real do produto não existe mais');",
'quality media exists')
t=rep(t,
"  return { score, blockers, warnings, maxSimilarity: Number(maxSimilarity.toFixed(3)), canAutoApprove: blockers.length === 0 && score >= intEnv('AUTO_APPROVE_MIN_SCORE', 85) };",
"  const moderationReady = post.origin !== 'planner' || post.moderation?.checked === true;\n  return { score, blockers, warnings, maxSimilarity: Number(maxSimilarity.toFixed(3)), canAutoApprove: blockers.length === 0 && moderationReady && score >= intEnv('AUTO_APPROVE_MIN_SCORE', 85) };",
'autoapprove moderation')

# Planner: se visual IA é obrigatório, não converte falha em post fallback; segundo scheduler tenta de novo.
for kind in ['sale','hype','growth']:
    old = "catch (err) { visualAiError = err.message; console.error('[creative-ai-%s]', err); creative = await createCreative" % kind
    if old in t:
        new = "catch (err) { visualAiError = err.message; console.error('[creative-ai-%s]', err); if (boolEnv('REQUIRE_AI_VISUAL', true) && origin === 'planner') throw err; creative = await createCreative" % kind
        t=t.replace(old,new,1)
    else: raise RuntimeError(f'[planner fallback {kind}] trecho não encontrado')

# Regeneração local/original precisa atualizar visualMode corretamente.
t=rep(t,
"    patch = { mediaKey: product.mediaKey || '', imageMime: product.imageMime || '', imageUrl: product.mediaKey ? '' : product.imageUrl || '', generatedVisual: false };",
"    patch = { mediaKey: product.mediaKey || '', imageMime: product.imageMime || '', imageUrl: '', generatedVisual: false, visualMode: 'original', visualAiError: null };",
'original visual mode')
t=rep(t,
"    patch = { mediaKey: creative.mediaKey, imageMime: creative.imageMime, imageUrl: '', generatedVisual: true, creativeVariant: creative.variant };",
"    patch = { mediaKey: creative.mediaKey, imageMime: creative.imageMime, imageUrl: '', generatedVisual: true, visualMode: 'template', visualAiError: null, creativeVariant: creative.variant };",
'template visual mode')

# Escolha de venda elimina referência sem blob real.
t=sub(t, r"export async function chooseSaleProduct\(\) \{.*?\n\}\n\nfunction planKey", r'''export async function chooseSaleProduct() {
  const products = (await listProducts()).filter(p => p.active && p.verified && p.shopeeUrl && p.mediaKey && productFreshnessState(p, Date.now(), intEnv('PRODUCT_MAX_STALE_DAYS', 14)).fresh);
  if (!products.length) throw new Error('Nenhum produto pronto para venda: precisa estar ativo, confirmado, com link Shopee, foto interna e catálogo recente.');
  const recent = await listRecentPosts(70);
  const recentIds = new Set(recent.filter(p => p.status === 'published' && p.plannerType === 'sale' && p.productId).slice(0, 5).map(p => p.productId));
  products.sort((a, b) => {
    const ar = recentIds.has(a.id) ? 1 : 0, br = recentIds.has(b.id) ? 1 : 0;
    if (ar !== br) return ar - br;
    const perf = Number(b.performanceScore || 0) - Number(a.performanceScore || 0);
    if (Math.abs(perf) > 0.01) return perf;
    return (a.lastPostedAt ? Date.parse(a.lastPostedAt) : 0) - (b.lastPostedAt ? Date.parse(b.lastPostedAt) : 0);
  });
  for (const product of products) if (await mediaExists(product.mediaKey)) return product;
  throw new Error('Os produtos elegíveis estão com arquivos de foto ausentes. Atualize as fotos antes da automação.');
}

function planKey''', 'chooseSale media existence')

# Job lock real, terminal error e watchdog; evita duas imagens/posts para o mesmo job.
t=sub(t, r"export async function getJob\(id\) \{.*?\n\}\n\nasync function queueJob", r'''export async function getJob(id) {
  const entry = await getJobEntry(id);
  if (!entry) return null;
  const job = entry.job;
  if (job.status === 'running' && Date.now() - Date.parse(job.updatedAt || 0) > 16 * 60_000) {
    return casJob(id, current => current.status === 'running' ? ({ ...current, status: 'error', error: 'O worker excedeu o tempo máximo. Tente novamente.', workerToken: null, completedAt: nowIso(), updatedAt: nowIso() }) : current).catch(() => job);
  }
  return job;
}

async function queueJob''', 'getJob watchdog')

t=sub(t, r"export async function runGenerationJob\(id\) \{.*?\n\}\n\nasync function validateBeforePublish", r'''async function claimGenerationJob(id) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await getJobEntry(id);
    if (!entry) throw new Error('Job não encontrado.');
    const job = entry.job;
    if (['complete', 'error'].includes(job.status)) return { claimed: false, job };
    if (job.status === 'running' && Date.now() - Date.parse(job.updatedAt || 0) < 16 * 60_000) return { claimed: false, job };
    const token = uuid();
    const next = { ...job, status: 'running', workerToken: token, updatedAt: nowIso(), error: null };
    const result = await jobsStore().setJSON(`job/${id}`, next, { onlyIfMatch: entry.etag });
    if (result.modified) return { claimed: true, token, job: next };
  }
  throw new Error('Outro worker assumiu este job.');
}

export async function runGenerationJob(id) {
  const claim = await claimGenerationJob(id);
  if (!claim.claimed) return claim.job;
  try {
    let result;
    if (claim.job.kind === 'manual-generation') result = await generateManualType(claim.job.type, claim.job.productId || null);
    else if (claim.job.kind === 'creative-ai') result = await regeneratePostCreativeAi(claim.job.postId);
    else if (claim.job.kind === 'shopee-sync') result = await syncShopeeCatalog({ force: false });
    else throw new Error('Tipo de job desconhecido.');
    return await casJob(id, job => {
      if (job.workerToken !== claim.token) throw new Error('O lock deste job mudou durante a execução.');
      const publicResult = claim.job.kind === 'shopee-sync' ? result : { postId: result.id };
      return { ...job, status: 'complete', result: publicResult, workerToken: null, updatedAt: nowIso(), completedAt: nowIso() };
    });
  } catch (err) {
    await casJob(id, job => job.workerToken === claim.token ? ({ ...job, status: 'error', error: err.message, workerToken: null, updatedAt: nowIso(), completedAt: nowIso() }) : job).catch(() => {});
    throw err;
  }
}

async function validateBeforePublish''', 'job concurrency')

# Manual sync também vira job de background.
t=rep(t,
"export async function queueCreativeGeneration(postId) {\n  if (!postId) throw new Error('Post obrigatório.');\n  return queueJob({ kind: 'creative-ai', postId });\n}",
"export async function queueCreativeGeneration(postId) {\n  if (!postId) throw new Error('Post obrigatório.');\n  return queueJob({ kind: 'creative-ai', postId });\n}\n\nexport async function queueShopeeSync() {\n  return queueJob({ kind: 'shopee-sync' });\n}",
'queue shopee sync')

# Performance: sempre captura h24 antes de h72; snapshots registram idade real.
t=rep(t,
"  if (ageHours >= 72 && ageHours <= 14 * 24 && !windows.h72) return 'h72';\n  if (ageHours >= 24 && ageHours <= 14 * 24 && !windows.h24) return 'h24';",
"  if (ageHours >= 24 && ageHours <= 14 * 24 && !windows.h24) return 'h24';\n  if (ageHours >= 72 && ageHours <= 14 * 24 && !windows.h72) return 'h72';",
'performance window order')
t=rep(t,
"  const snapshot = { reactions, comments, shares, score, checkedAt: nowIso(), window: windowKey };",
"  const snapshot = { reactions, comments, shares, score, checkedAt: nowIso(), window: windowKey, ageHours: Number(((Date.now() - Date.parse(post.publishedAt || 0)) / 3600_000).toFixed(1)) };",
'performance age')

# Health de auto-sync desligado precisa aparecer como desligado.
t=rep(t,
"  if (result?.autoPlan === false || result?.autoPublish === false) return 'off';",
"  if (result?.autoPlan === false || result?.autoPublish === false || result?.autoSyncShopee === false) return 'off';",
'health autosync off')

# Métricas/status de produtos realmente prontos.
t=rep(t,
"shopee: { storeUrl: SHOPEE_STORE_URL, lastSync: sync || null, linkedProducts: products.filter(p => p.shopeeUrl).length, verifiedProducts: products.filter(p => p.active && p.verified && p.shopeeUrl).length },",
"shopee: { storeUrl: SHOPEE_STORE_URL, lastSync: sync || null, linkedProducts: products.filter(p => p.shopeeUrl).length, verifiedProducts: products.filter(p => p.active && p.verified && p.shopeeUrl && p.mediaKey && p.catalogFresh).length },",
'bootstrap ready products')

# Cleanup semanal pode fazer full scan por segurança; também remove jobs velhos.
t=sub(t, r"export async function cleanupOrphanMedia\(\{ minAgeDays = 14, limit = 80 \} = \{\}\) \{.*?\n\}\n\nexport async function statusSummary", r'''export async function cleanupOrphanMedia({ minAgeDays = 14, limit = 80 } = {}) {
  const [products, posts] = await Promise.all([listJson(productsStore, 'product/'), listJson(postsStore, 'post/')]);
  const referenced = new Set([...products.map(p => p.mediaKey).filter(Boolean), ...posts.map(p => p.mediaKey).filter(Boolean)]);
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
  const jobs = await jobsStore().list({ prefix: 'job/' });
  let jobsDeleted = 0;
  const jobCutoff = Date.now() - 7 * 86400_000;
  for (const blob of jobs.blobs.slice(0, 100)) {
    try {
      const job = await jobsStore().get(blob.key, { type: 'json', consistency: 'strong' });
      const timestamp = Date.parse(job?.completedAt || job?.createdAt || 0);
      if (timestamp && timestamp < jobCutoff && ['complete','error'].includes(job?.status)) { await jobsStore().delete(blob.key); jobsDeleted++; }
    } catch {}
  }
  const result = { checked, deleted, jobsDeleted, referenced: referenced.size, at: nowIso() };
  await audit('media_cleanup', result);
  return result;
}

export async function statusSummary''', 'cleanup jobs/full products')

write(p,t)

# ---------------- API: sync async ----------------
p='netlify/functions/api.mjs'; t=read(p)
t=rep(t,
"  queueManualGeneration, queueCreativeGeneration, getJob, regeneratePostCreative, patchPost, generatePlan, syncShopeeCatalog, validateMetaConnection,",
"  queueManualGeneration, queueCreativeGeneration, queueShopeeSync, getJob, regeneratePostCreative, patchPost, generatePlan, validateMetaConnection,",
'api import sync queue')
t=rep(t,
"    if (route === '/shopee/sync' && method === 'POST') return json(await syncShopeeCatalog({ force: false }));",
"    if (route === '/shopee/sync' && method === 'POST') return json(await queueShopeeSync(), 202);",
'api shopee background')
write(p,t)

# ---------------- frontend ----------------
p='public/app.js'; t=read(p)
t=rep(t,
"function productReady(p){return Boolean(p.active&&p.verified&&p.shopeeUrl&&(p.mediaKey||p.imageUrl))}",
"function productReady(p){return Boolean(p.active&&p.verified&&p.shopeeUrl&&p.mediaKey&&p.catalogFresh!==false)}",
'frontend product ready')
t=t.replace("filter==='no-photo'&&!(p.mediaKey||p.imageUrl)", "filter==='no-photo'&&!p.mediaKey")
t=t.replace("${!p.verified&&p.shopeeUrl&&(p.mediaKey||p.imageUrl)?", "${!p.verified&&p.shopeeUrl&&p.mediaKey?")
t=t.replace("state.products.some(x=>x.id===p.productId&&(x.mediaKey||x.imageUrl))", "state.products.some(x=>x.id===p.productId&&x.mediaKey)")
# renderProducts no longer double-checks freshness separately.
t=t.replace("const ready=productReady(p)&&p.catalogFresh!==false;", "const ready=productReady(p);")
# Manual sync polls background job.
t=sub(t, r"\$\('#syncShopee'\)\.addEventListener\('click',async\(\)=>\{.*?\}\);", r'''$('#syncShopee').addEventListener('click',async()=>{if(!confirm('Buscar candidatos reais na loja Shopee? A busca consome a cota de sincronização do dia.'))return;try{$('#syncShopee').disabled=true;toast('Pesquisando a Shopee em segundo plano…');const job=await api('/api/shopee/sync',{method:'POST'});const done=await waitForJob(job.id);const r=done.result||{};toast(`${r.found||0} encontrados · ${r.created||0} novos · ${r.updated||0} atualizados.`);await load()}catch(e){toast(e.message)}finally{$('#syncShopee').disabled=false}});''', 'frontend async sync')
write(p,t)

# ---------------- schedules / health ----------------
p='netlify/functions/collect-performance.mjs'; t=read(p)
t=t.replace("recordHealth('performance', result)", "recordHealth('collect-performance', result)").replace("recordHealth('performance', { error: err.message })", "recordHealth('collect-performance', { error: err.message })")
t=t.replace("schedule: '0 6 * * *'", "schedule: '0 6,18 * * *'")
write(p,t)

# ---------------- env/docs ----------------
p='.env.example'; t=read(p).replace('OPENAI_IMAGE_QUALITY=low','OPENAI_IMAGE_QUALITY=smart'); write(p,t)
p='README.md'; t=read(p).replace('`OPENAI_IMAGE_QUALITY=low`','`OPENAI_IMAGE_QUALITY=smart`')
t=t.replace('- 03:00: métricas com snapshots de 24 h e 72 h.','- 03:00 e 15:00: coleta de métricas; cada post guarda snapshots comparáveis de ~24 h e ~72 h.')
write(p,t)

# ---------------- tests ----------------
p='tests/v07.test.mjs'; t=read(p)
t=t.replace("import { copyHasUrl, stripUrls, sensitiveReasons, buildImagePrompt, extractWebEvidence } from '../netlify/lib/creative-ai.mjs';", "import { copyHasUrl, stripUrls, sensitiveReasons, buildImagePrompt, extractWebEvidence, generateImageBuffer, moderateText } from '../netlify/lib/creative-ai.mjs';")
t += r'''

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
'''
write(p,t)

# CI passa a checar todos os módulos lib também.
p='package.json'; t=read(p)
old='node --check public/app.js && node --check netlify/lib/agent.mjs && node --check netlify/functions/api.mjs && for f in netlify/functions/*.mjs; do node --check \\"$f\\"; done'
# JSON já contém escapes; operação simples pelo fragmento legível.
t=t.replace('node --check public/app.js && node --check netlify/lib/agent.mjs && node --check netlify/functions/api.mjs && for f in netlify/functions/*.mjs; do node --check \\"$f\\"; done','node --check public/app.js && for f in netlify/lib/*.mjs netlify/functions/*.mjs; do node --check \\"$f\\"; done')
write(p,t)

# Remove ferramentas temporárias do pacote final (o workflow em execução continua normalmente).
for temp in [
    '.github/scripts/apply-v07.py',
    '.github/scripts/finalize-v07.py',
    '.github/workflows/apply-v07.yml',
    '.github/workflows/finalize-v07.yml'
]:
    f=ROOT/temp
    if f.exists(): f.unlink()

print('v0.7 hardening final aplicado')
