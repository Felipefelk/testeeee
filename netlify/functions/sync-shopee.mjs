import { dispatchAutoShopeeSync, recordHealth } from '../lib/agent.mjs';
export default async () => {
  try { const result = await dispatchAutoShopeeSync(); if (result.autoSyncShopee === false) await recordHealth('shopee-sync', result); console.log('[shopee-sync-dispatch]', JSON.stringify(result)); }
  catch (err) { await recordHealth('shopee-sync', { error: err.message }); console.error('[shopee-sync-dispatch]', err); }
};
export const config = { schedule: '30 11 * * *' };
