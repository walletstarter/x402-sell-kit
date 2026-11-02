// Sales per topic, for the refresh-when-paid rule (README, step 7): refresh a bundle only after its
// own sales since its last upload have paid for that refresh. Only settled payments count, and never
// your own wallets (OWN_WALLETS). Fee reads (v2: one in twenty, paid to makememoneynomistakes.ai)
// count as reads of the topic and are counted apart in fee_reads, so you can see both. No Hono and no
// x402 here, so it can be tested alone.

/** The part of Workers KV this file uses. */
export interface CountStore {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

/** Sales live under this prefix. ':' is never in a topic name, so these keys are never listed or sold. */
export const READS_PREFIX = 'reads:';
export const readsKey = (topic: string): string => `${READS_PREFIX}${topic}`;

export interface Reads {
  /** Settled reads of the topic, your own wallets' left out, fee reads included. */
  count: number;
  /** Of those, the reads paid to makememoneynomistakes.ai as the fee (v2). */
  fee_reads: number;
  last_at: string | null;
}

const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export async function readCount(store: CountStore, topic: string): Promise<Reads> {
  const v = (await store.get(readsKey(topic), 'json')) as { count?: unknown; fee_reads?: unknown; last_at?: unknown } | null;
  return { count: whole(v?.count), fee_reads: whole(v?.fee_reads), last_at: typeof v?.last_at === 'string' ? v.last_at : null };
}

/** OWN_WALLETS as lowercase addresses. */
export function ownWallets(list: string | undefined): string[] {
  return (list ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
}

/** The payer named in a PAYMENT-RESPONSE receipt (base64 JSON), lowercase, or '' when unreadable. */
export function receiptPayer(header: string): string {
  try {
    const json = JSON.parse(atob(header.trim().replace(/-/g, '+').replace(/_/g, '/'))) as { payer?: unknown };
    return typeof json.payer === 'string' ? json.payer.toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Counts one settled sale of `topic`, unless one of your own wallets paid. `fee`: this read was paid to
 * makememoneynomistakes.ai (counted, and counted apart). Returns whether it counted.
 * KV is not atomic: two sales in the same instant can count as one. It can undercount, never overcount.
 */
export async function countSale(store: CountStore, topic: string, receipt: string, own: string | undefined, now = new Date(), fee = false): Promise<boolean> {
  const payer = receiptPayer(receipt);
  if (payer && ownWallets(own).includes(payer)) return false;
  const was = await readCount(store, topic);
  await store.put(readsKey(topic), JSON.stringify({ count: was.count + 1, fee_reads: was.fee_reads + (fee ? 1 : 0), last_at: now.toISOString() }));
  return true;
}

/** Sales since the last upload: the total now, less the total when the bundle was last uploaded. */
export function salesSince(total: number, atUpload: number | undefined): number {
  return Math.max(0, total - (atUpload ?? 0));
}
