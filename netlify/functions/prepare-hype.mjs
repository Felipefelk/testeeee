import { dispatchPrepareDailySlot, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await dispatchPrepareDailySlot('hype'); if (result.autoPlan === false) await recordHealth('prepare-hype', result); console.log('[prepare-hype-dispatch]', JSON.stringify(result)); }
  catch (err) { await recordHealth('prepare-hype', { error: err.message }); console.error('[prepare-hype-dispatch]', err); }
};
export const config = { schedule: '15,35 17 * * *' };
