import {
  SESSION_COOKIE, safeEqual, signSession, isAuthenticated, checkLoginRate, resetLoginRate,
  bootstrapSummary, createProduct, updateProduct, updateProductImage, confirmProduct, deleteProduct,
  queueManualGeneration, queueCreativeGeneration, queueShopeeSync, getJob, regeneratePostCreative, patchPost, generatePlan, validateMetaConnection,
  publishById, resolvePostReview, getMedia, refreshRecentPerformance
} from '../lib/agent.mjs';

const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { ...baseHeaders, ...headers } });
const errorResponse = err => {
  console.error('[api]', err);
  return json({ error: err?.message || 'Erro inesperado.', ambiguous: Boolean(err?.ambiguous) }, Number(err?.status || 400));
};

function routePath(req) {
  const p = new URL(req.url).pathname;
  const api = p.lastIndexOf('/api/');
  if (api >= 0) return '/' + p.slice(api + 5);
  const fn = p.indexOf('/.netlify/functions/api/');
  if (fn >= 0) return '/' + p.slice(fn + '/.netlify/functions/api/'.length);
  if (p.startsWith('/media/')) return p;
  return p;
}

function ipOf(req, context) {
  return context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function originDenied(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const expected = new URL(req.url).origin;
  if (origin !== expected) return json({ error: 'Origem da requisição não autorizada.' }, 403);
  return null;
}

function authRequired(req) {
  if (!process.env.APP_PASSWORD) return json({ error: 'APP_PASSWORD não configurada. O painel foi bloqueado por segurança.' }, 503);
  if (!isAuthenticated(req)) return json({ error: 'Sessão não autenticada.', authRequired: true }, 401);
  return null;
}

export default async (req, context) => {
  try {
    const route = routePath(req);
    const method = req.method.toUpperCase();
    const badOrigin = originDenied(req); if (badOrigin) return badOrigin;

    if (route === '/auth/status' && method === 'GET') return json({ configured: Boolean(process.env.APP_PASSWORD), authenticated: isAuthenticated(req) });

    if (route === '/login' && method === 'POST') {
      if (!process.env.APP_PASSWORD) return json({ error: 'APP_PASSWORD não configurada.' }, 503);
      const ip = ipOf(req, context);
      if (!await checkLoginRate(ip)) return json({ error: 'Muitas tentativas. Aguarde antes de tentar novamente.' }, 429);
      const body = await req.json().catch(() => ({}));
      if (!safeEqual(String(body.password || ''), process.env.APP_PASSWORD)) return json({ error: 'Senha inválida.' }, 401);
      await resetLoginRate(ip);
      const exp = Date.now() + 12 * 60 * 60 * 1000;
      return json({ ok: true, expiresAt: new Date(exp).toISOString() }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(signSession(exp))}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200`
      });
    }

    if (route === '/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0` });

    const denied = authRequired(req); if (denied) return denied;

    if (route.startsWith('/media/') && method === 'GET') {
      const key = decodeURIComponent(route.slice('/media/'.length));
      const entry = await getMedia(key);
      if (!entry) return new Response(null, { status: 404, headers: baseHeaders });
      return new Response(entry.data, { headers: { 'content-type': entry.metadata?.mime || 'image/webp', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
    }

    if (route === '/bootstrap' && method === 'GET') return json(await bootstrapSummary());
    if (route === '/meta/validate' && method === 'POST') return json(await validateMetaConnection(true));
    if (route === '/performance/refresh' && method === 'POST') return json(await refreshRecentPerformance(6));
    if (route === '/shopee/sync' && method === 'POST') return json(await queueShopeeSync(), 202);

    if (route === '/products' && method === 'POST') {
      const form = await req.formData();
      const file = form.get('image');
      return json(await createProduct({
        name: form.get('name'), category: form.get('category'), price: form.get('price'), description: form.get('description'),
        imageUrl: form.get('imageUrl'), shopeeUrl: form.get('shopeeUrl'), file: file instanceof File && file.size ? file : null
      }));
    }

    const productImageMatch = route.match(/^\/products\/([^/]+)\/image$/);
    if (productImageMatch && method === 'POST') {
      const form = await req.formData();
      const file = form.get('image');
      if (!(file instanceof File) || !file.size) return json({ error: 'Envie uma imagem.' }, 400);
      return json(await updateProductImage(productImageMatch[1], file));
    }

    const productConfirmMatch = route.match(/^\/products\/([^/]+)\/confirm$/);
    if (productConfirmMatch && method === 'POST') return json(await confirmProduct(productConfirmMatch[1]));

    const productMatch = route.match(/^\/products\/([^/]+)$/);
    if (productMatch && method === 'PATCH') return json(await updateProduct(productMatch[1], await req.json()));
    if (productMatch && method === 'DELETE') {
      const result = await deleteProduct(productMatch[1]);
      return result ? json(result) : json({ error: 'Produto não encontrado.' }, 404);
    }

    if (route === '/generate' && method === 'POST') {
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
    }

    const postMatch = route.match(/^\/posts\/([^/]+)$/);
    if (postMatch && method === 'PATCH') return json(await patchPost(postMatch[1], await req.json()));

    const creativeMatch = route.match(/^\/posts\/([^/]+)\/creative$/);
    if (creativeMatch && method === 'POST') { const body = await req.json().catch(() => ({})); if (body.mode === 'ai') return json(await queueCreativeGeneration(creativeMatch[1]), 202); return json(await regeneratePostCreative(creativeMatch[1], body.mode || 'template')); }

    const reviewMatch = route.match(/^\/posts\/([^/]+)\/resolve-review$/);
    if (reviewMatch && method === 'POST') { const body = await req.json().catch(() => ({})); return json(await resolvePostReview(reviewMatch[1], body.resolution)); }

    const pubMatch = route.match(/^\/posts\/([^/]+)\/publish$/);
    if (pubMatch && method === 'POST') return json(await publishById(pubMatch[1]));

    if (route === '/planner/generate' && method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return json(await generatePlan(body.date));
    }

    return json({ error: `Rota não encontrada: ${method} ${route}` }, 404);
  } catch (err) {
    return errorResponse(err);
  }
};
