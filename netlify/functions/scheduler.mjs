import { ensureDailyPlan, publishDuePosts } from '../lib/agent.mjs';

export default async () => {
  const result = { plan: null, publish: null };
  try { result.plan = await ensureDailyPlan(); }
  catch (err) { result.plan = { error: err.message }; console.error('[auto-plan]', err); }
  try { result.publish = await publishDuePosts(3); }
  catch (err) { result.publish = { error: err.message }; console.error('[auto-publish]', err); }
  console.log('[scheduler]', JSON.stringify(result));
};

export const config = { schedule: '*/15 * * * *' };
