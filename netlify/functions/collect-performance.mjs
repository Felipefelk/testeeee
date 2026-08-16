import { refreshRecentPerformance, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await refreshRecentPerformance(6); await recordHealth('performance', result); console.log('[performance]', JSON.stringify(result)); }
  catch (err) { await recordHealth('performance', { error: err.message }); console.error('[performance]', err); }
};
export const config = { schedule: '0 6 * * *' };
