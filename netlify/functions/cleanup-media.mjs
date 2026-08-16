import { dispatchCleanupMedia, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await dispatchCleanupMedia(); console.log('[cleanup-media-dispatch]', JSON.stringify(result)); }
  catch (err) { await recordHealth('cleanup-media', { error: err.message }); console.error('[cleanup-media-dispatch]', err); }
};
export const config = { schedule: '30 6 * * 0' };
