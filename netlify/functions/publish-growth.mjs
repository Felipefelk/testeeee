import { publishDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await publishDailySlot('growth'); await recordHealth('publish-growth', result); console.log('[publish-growth]', JSON.stringify(result)); }
  catch (err) { await recordHealth('publish-growth', { error: err.message }); console.error('[publish-growth]', err); }
};
export const config = { schedule: '0 23 * * *' };
