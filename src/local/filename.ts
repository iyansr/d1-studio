import { createHash, createHmac } from 'node:crypto';

/**
 * The file Miniflare writes for a D1 database: the Durable Object ID it
 * derives from `id`, in hex, plus `.sqlite`. Verified against Wrangler 4.142.
 */
export function localD1FileName(id: string): string {
  const key = createHash('sha256').update('miniflare-D1DatabaseObject').digest();
  const nameHmac = createHmac('sha256', key).update(id).digest().subarray(0, 16);
  const hmac = createHmac('sha256', key).update(nameHmac).digest().subarray(0, 16);
  return `${Buffer.concat([nameHmac, hmac]).toString('hex')}.sqlite`;
}
