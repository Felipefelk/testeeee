import {
  SESSION_COOKIE, TIMEZONE, safeEqual, signSession, isAuthenticated, checkLoginRate, resetLoginRate,
  statusSummary, dataSummary, createProduct, deleteProduct, getProduct, generateCaption, insertPost,
  patchPost, generatePlan, validateMetaConnection, publishById, getMedia, localToUtc
} from '../lib/agent.mjs';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const errorResponse = (err) => {
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

function authRequired(req) {
  if (!process.env.APP_PASSWORD) return json({ error: 'APP_PASSWORD não configurada. O painel foi bloqueado por segurança.' }, 503);
  if (!isAuthenticated(req)) return json({ error: 'Sessão não autenticada.', authRequired: true }, 401);
  return null;
}

export default async (req, context) => {
  try {
    const route = routePath(req);
    const method = req.method.toUpperCase();

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
      if (!entry) return new Response(null, { status: 404 });
      return new Response(entry.data, { headers: { 'content-type': entry.metadata?.mime || 'image/webp', 'cache-control': 'private, max-age=3600' } });
    }

    if (route === '/status' && method === 'GET') return json(await statusSummary());
    if (route === '/data' && method === 'GET') return json(await dataSummary());
    if (route === '/meta/validate' && method === 'POST') return json(await validateMetaConnection(true));

    if (route === '/products' && method === 'POST') {
      const form = await req.formData();
      const file = form.get('image');
      return json(await createProduct({ name: form.get('name'), category: form.get('category'), price: form.get('price'), description: form.get('description'), imageUrl: form.get('imageUrl'), file: file instanceof File && file.size ? file : null }));
    }

    const productMatch = route.match(/^\/products\/([^/]+)$/);
    if (productMatch && method === 'DELETE') {
      const result = await deleteProduct(productMatch[1]);
      return result ? json(result) : json({ error: 'Produto não encontrado.' }, 404);
    }

    if (route === '/generate' && method === 'POST') {
      const body = await req.json(); const product = await getProduct(body.productId);
      if (!product || !product.active) return json({ error: 'Produto não encontrado.' }, 404);
      const message = await generateCaption(product, 'product_sale');
      return json(await insertPost({ product, message, origin: 'manual' }));
    }

    if (route === '/posts' && method === 'POST') {
      const body = await req.json(); const product = body.productId ? await getProduct(body.productId) : null;
      return json(await insertPost({ product, message: body.message, imageUrl: body.imageUrl || '', scheduledAt: body.scheduledLocal ? localToUtc(body.scheduledLocal) : null, origin: 'manual' }));
    }

    const postMatch = route.match(/^\/posts\/([^/]+)$/);
    if (postMatch && method === 'PATCH') return json(await patchPost(postMatch[1], await req.json()));

    const pubMatch = route.match(/^\/posts\/([^/]+)\/publish$/);
    if (pubMatch && method === 'POST') return json(await publishById(pubMatch[1]));

    if (route === '/planner/generate' && method === 'POST') return json(await generatePlan((await req.json().catch(() => ({}))).date));

    return json({ error: `Rota não encontrada: ${method} ${route}` }, 404);
  } catch (err) {
    return errorResponse(err);
  }
};
