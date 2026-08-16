import {
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
