import { prepareDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await prepareDailySlot('hype'); await recordHealth('prepare-hype', result); console.log('[prepare-hype]', JSON.stringify(result)); }
  catch (err) { await recordHealth('prepare-hype', { error: err.message }); console.error('[prepare-hype]', err); }
};
export const config = { schedule: '15,35 17 * * *' };
