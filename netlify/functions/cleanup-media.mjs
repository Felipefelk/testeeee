import { cleanupOrphanMedia, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await cleanupOrphanMedia(); await recordHealth('cleanup-media', result); console.log('[cleanup-media]', JSON.stringify(result)); }
  catch (err) { await recordHealth('cleanup-media', { error: err.message }); console.error('[cleanup-media]', err); }
};
export const config = { schedule: '30 6 * * 0' };
