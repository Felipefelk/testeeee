import { dispatchPrepareDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await dispatchPrepareDailySlot('growth'); if (result.autoPlan === false) await recordHealth('prepare-growth', result); console.log('[prepare-growth-dispatch]', JSON.stringify(result)); }
  catch (err) { await recordHealth('prepare-growth', { error: err.message }); console.error('[prepare-growth-dispatch]', err); }
};
export const config = { schedule: '15,35 22 * * *' };
