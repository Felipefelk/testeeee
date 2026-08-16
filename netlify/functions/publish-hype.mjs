import { publishDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await publishDailySlot('hype'); await recordHealth('publish-hype', result); console.log('[publish-hype]', JSON.stringify(result)); }
  catch (err) { await recordHealth('publish-hype', { error: err.message }); console.error('[publish-hype]', err); }
};
export const config = { schedule: '0,10 18 * * *' };
