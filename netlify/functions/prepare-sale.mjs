import { prepareDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await prepareDailySlot('sale'); await recordHealth('prepare-sale', result); console.log('[prepare-sale]', JSON.stringify(result)); }
  catch (err) { await recordHealth('prepare-sale', { error: err.message }); console.error('[prepare-sale]', err); }
};
export const config = { schedule: '15,35 12 * * *' };
