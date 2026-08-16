from pathlib import Path

agent_p=Path('netlify/lib/agent.mjs'); api_p=Path('netlify/functions/api.mjs'); app_p=Path('public/app.js'); pkg_p=Path('package.json'); lock_p=Path('package-lock.json')
agent=agent_p.read_text(); api=api_p.read_text(); app=app_p.read_text(); pkg=pkg_p.read_text(); lock=lock_p.read_text()

def rep(text,old,new,label):
    if old not in text: raise SystemExit(f'faltou {label}')
    return text.replace(old,new,1)

# Usa a imagem já validada para decidir se o produto nasce confirmado.
agent=rep(agent,
"  const saved = await persistSafeImage(file);\n  const link = await normalizeShopeeUrl(shopeeUrl);",
"  const saved = await persistSafeImage(file);\n  const publicImage = validateHttpsUrl(imageUrl);\n  const link = await normalizeShopeeUrl(shopeeUrl);",
'publicImage var')
agent=rep(agent,
"    description: String(description || '').trim(), imageUrl: validateHttpsUrl(imageUrl), shopeeUrl: link,\n    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,\n    verified: Boolean(link && (saved?.mediaKey || imageUrl)), verifiedAt: link && (saved?.mediaKey || imageUrl) ? now : null,",
"    description: String(description || '').trim(), imageUrl: publicImage, shopeeUrl: link,\n    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,\n    verified: Boolean(link && (saved?.mediaKey || publicImage)), verifiedAt: link && (saved?.mediaKey || publicImage) ? now : null,",
'publicImage use')

# Estado needs_review ganha resolução explícita, sem nova tentativa automática.
marker="export async function publishDailySlot(type, dateRaw = null) {"
resolve_func='''export async function resolvePostReview(id, resolution) {\n  if (!['published', 'cancelled'].includes(resolution)) throw new Error('Resolução inválida.');\n  const updated = await casPost(id, current => {\n    if (current.status !== 'needs_review') throw new Error('Este post não está aguardando revisão.');\n    const now = nowIso();\n    if (resolution === 'published') return { ...current, status: 'published', publishedAt: current.publishedAt || now, error: null, errorCode: null, errorSubcode: null, updatedAt: now };\n    return { ...current, status: 'cancelled', error: null, errorCode: null, errorSubcode: null, updatedAt: now };\n  });\n  if (updated.dailyDate && updated.plannerType) await markPlanSlot(updated.dailyDate, updated.plannerType, { state: resolution, postId: updated.id, ...(resolution === 'published' ? { publishedAt: updated.publishedAt } : {}) });\n  await audit('review_resolved', { postId: id, resolution });\n  return updated;\n}\n\n'''
if 'export async function resolvePostReview' not in agent:
    agent=agent.replace(marker,resolve_func+marker,1)

api=rep(api,
"  publishById, getMedia, refreshRecentPerformance",
"  publishById, resolvePostReview, getMedia, refreshRecentPerformance",
'api resolve import')
api=rep(api,
"    const pubMatch = route.match(/^\\/posts\\/([^/]+)\\/publish$/);\n    if (pubMatch && method === 'POST') return json(await publishById(pubMatch[1]));",
"    const reviewMatch = route.match(/^\\/posts\\/([^/]+)\\/resolve-review$/);\n    if (reviewMatch && method === 'POST') { const body = await req.json().catch(() => ({})); return json(await resolvePostReview(reviewMatch[1], body.resolution)); }\n\n    const pubMatch = route.match(/^\\/posts\\/([^/]+)\\/publish$/);\n    if (pubMatch && method === 'POST') return json(await publishById(pubMatch[1]));",
'api resolve route')

# UI para resolver publicação incerta conscientemente.
needle="${!['published','publishing','cancelled','needs_review'].includes(p.status)?`<button class=\"btn danger\" data-post-action=\"cancel\" data-id=\"${esc(p.id)}\">Cancelar</button>`:''}"
replace="${p.status==='needs_review'?`<button class=\"btn secondary\" data-post-action=\"review-published\" data-id=\"${esc(p.id)}\">Já está no Facebook</button><button class=\"btn danger\" data-post-action=\"review-cancelled\" data-id=\"${esc(p.id)}\">Não publicou</button>`:''}${!['published','publishing','cancelled','needs_review'].includes(p.status)?`<button class=\"btn danger\" data-post-action=\"cancel\" data-id=\"${esc(p.id)}\">Cancelar</button>`:''}"
app=rep(app,needle,replace,'review buttons')
needle2="else if(b.dataset.postAction==='original'){await api(`/api/posts/${id}/creative`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'original'})});toast('Foto original aplicada.')}await load()"
replace2="else if(b.dataset.postAction==='original'){await api(`/api/posts/${id}/creative`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'original'})});toast('Foto original aplicada.')}else if(b.dataset.postAction==='review-published'){if(!confirm('Confirma que você verificou no Facebook e o post está publicado?'))return;await api(`/api/posts/${id}/resolve-review`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resolution:'published'})});toast('Revisão encerrada como publicado.')}else if(b.dataset.postAction==='review-cancelled'){if(!confirm('Confirma que o post NÃO apareceu no Facebook?'))return;await api(`/api/posts/${id}/resolve-review`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resolution:'cancelled'})});toast('Revisão encerrada sem republicar.')}await load()"
app=rep(app,needle2,replace2,'review handlers')

# Auditoria humana do novo evento.
app=rep(app,
"media_cleanup:['⌫','Limpeza de mídia',`${d.deleted||0} arquivos órfãos removidos`]",
"media_cleanup:['⌫','Limpeza de mídia',`${d.deleted||0} arquivos órfãos removidos`],review_resolved:['✓','Revisão de publicação encerrada',d.resolution==='published'?'Confirmado no Facebook':'Marcado como não publicado']",
'audit review')

# Check passa a validar também o JavaScript do navegador.
pkg=rep(pkg,
'"check": "node --check netlify/lib/agent.mjs && node --check netlify/functions/api.mjs && for f in netlify/functions/*.mjs; do node --check \\\"$f\\\"; done"',
'"check": "node --check public/app.js && node --check netlify/lib/agent.mjs && node --check netlify/functions/api.mjs && for f in netlify/functions/*.mjs; do node --check \\\"$f\\\"; done"',
'package check frontend')

# Mantém package-lock semanticamente alinhado à versão do package.
lock=lock.replace('"version": "0.5.0"','"version": "0.6.0"',2)

agent_p.write_text(agent);api_p.write_text(api);app_p.write_text(app);pkg_p.write_text(pkg);lock_p.write_text(lock)
print('auditoria final v0.6 aplicada')
