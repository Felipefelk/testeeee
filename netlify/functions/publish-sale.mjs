import { publishDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await publishDailySlot('sale'); await recordHealth('publish-sale', result); console.log('[publish-sale]', JSON.stringify(result)); }
  catch (err) { await recordHealth('publish-sale', { error: err.message }); console.error('[publish-sale]', err); }
};
export const config = { schedule: '0 13 * * *' };
