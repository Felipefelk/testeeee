import { publishDuePosts } from '../lib/agent.mjs';

export default async () => {
  const result = await publishDuePosts(3);
  console.log('[scheduler]', JSON.stringify(result));
};

export const config = {
  schedule: '*/15 * * * *'
};
