import { prepareDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await prepareDailySlot('growth'); await recordHealth('prepare-growth', result); console.log('[prepare-growth]', JSON.stringify(result)); }
  catch (err) { await recordHealth('prepare-growth', { error: err.message }); console.error('[prepare-growth]', err); }
};
export const config = { schedule: '15,35 22 * * *' };
