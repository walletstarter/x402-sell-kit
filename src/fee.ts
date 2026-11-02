// Sell kit v2: the fee (README, "The fee"), the terms it reads from makememoneynomistakes.ai, and the
// registration that gives this kit a ledger and a results row. The fee is one bundle read in every
// ONE_IN paid to makememoneynomistakes.ai's address instead of yours, at the same cost to the buyer,
// with the same single signature per read; wallets grandfathered before the effective date pay 0%.
// The receiving address for the fee is pinned here, never taken from the network: the terms call
// only says whether this wallet pays and how often. Everything that reaches the network is in
// `feeTerms` and `register`; the decision itself (`isFeeRead`) is pure and tested alone.

export const KIT_VERSION = '2.0.0';
/** The fee: one read in this many (5%), when the terms say this wallet pays. */
export const DEFAULT_ONE_IN = 20;
/** Where the fee reads go: makememoneynomistakes.ai's one receiving address (SPEC §5 "Paid calls"). Pinned. */
export const FEE_TO = '0x751fd2618DEf5623b3766673160DD9a4dcDb6618';
export const DEFAULT_MMNM_ORIGIN = 'https://makememoneynomistakes.ai';
/** How long fetched terms are trusted before being read again; a failed read is retried sooner. */
export const TERMS_TTL_MS = 24 * 3600e3;
export const TERMS_RETRY_MS = 10 * 60e3;
/** How often the kit tells makememoneynomistakes.ai where it lives (a registration never expires; this keeps the display name current). */
export const REGISTER_EVERY_MS = 7 * 24 * 3600e3;

/** The part of Workers KV this file uses. */
export interface TermsStore {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}
export const TERMS_KEY = 'mmnm:terms';
export const REGISTERED_KEY = 'mmnm:registered';

export interface FeeTerms {
  /** Basis points of reads that go to the fee address: 500 = one in 20; 0 = none. */
  fee_bps: number;
  one_in: number;
  grandfathered: boolean;
  effective_date: string | null;
  /** When these terms were read, and whether the read succeeded (a failed read means 0% until the next try). */
  read_at: string;
  ok: boolean;
}

/** No fee: what applies while the terms cannot be read. Failing toward the seller, never toward us. */
export const NO_FEE = (readAt: string, ok: boolean): FeeTerms => ({ fee_bps: 0, one_in: 0, grandfathered: false, effective_date: null, read_at: readAt, ok });

/** Whether the read about to be sold, after `soldSoFar` counted sales of this topic, is a fee read. Pure. */
export function isFeeRead(soldSoFar: number, terms: Pick<FeeTerms, 'fee_bps' | 'one_in'>): boolean {
  if (terms.fee_bps <= 0 || terms.one_in <= 1) return false;
  return (soldSoFar + 1) % terms.one_in === 0;
}

/** The terms JSON as makememoneynomistakes.ai answers it, checked field by field. */
export function parseTerms(value: unknown, readAt: string): FeeTerms | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.fee_bps !== 'number' || !Number.isInteger(v.fee_bps) || v.fee_bps < 0 || v.fee_bps > 10_000) return null;
  const oneIn = typeof v.one_in === 'number' && Number.isInteger(v.one_in) && v.one_in >= 2 ? v.one_in : DEFAULT_ONE_IN;
  // A fee above 5% is never applied: the kit's promise is one read in twenty at most.
  return { fee_bps: Math.min(v.fee_bps, 500), one_in: Math.max(oneIn, DEFAULT_ONE_IN), grandfathered: v.grandfathered === true,
    effective_date: typeof v.effective_date === 'string' ? v.effective_date : null, read_at: readAt, ok: true };
}

/**
 * The fee terms for `payTo`, from KV while fresh, else from makememoneynomistakes.ai. Unreachable or
 * malformed: no fee for TERMS_RETRY_MS, then try again. Only `fee_bps`, `one_in` and `grandfathered`
 * come from the network; the fee address is FEE_TO.
 */
export async function feeTerms(store: TermsStore, payTo: string, origin = DEFAULT_MMNM_ORIGIN, now = new Date(), doFetch: typeof fetch = fetch): Promise<FeeTerms> {
  const cached = (await store.get(TERMS_KEY, 'json')) as FeeTerms | null;
  if (cached && typeof cached.read_at === 'string') {
    const age = now.getTime() - Date.parse(cached.read_at);
    if (age >= 0 && age < (cached.ok ? TERMS_TTL_MS : TERMS_RETRY_MS)) return cached;
  }
  let terms: FeeTerms | null = null;
  try {
    const res = await doFetch(`${origin}/api/v1/sellkit/terms?wallet=${payTo.toLowerCase()}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) terms = parseTerms(await res.json(), now.toISOString());
  } catch {
    terms = null;
  }
  const out = terms ?? NO_FEE(now.toISOString(), false);
  await store.put(TERMS_KEY, JSON.stringify(out));
  return out;
}

/**
 * Tells makememoneynomistakes.ai where this kit lives (POST /api/v1/sellkit/register {origin}), at most
 * once every REGISTER_EVERY_MS, so your wallet joins the Pathways ledger and gets a results row
 * labeled with DISPLAY_NAME. Only your Worker's public origin is sent. Never throws.
 */
export async function register(store: TermsStore, kitOrigin: string, mmnm = DEFAULT_MMNM_ORIGIN, now = new Date(), doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    if (!/^https:\/\//.test(kitOrigin)) return false;
    const last = (await store.get(REGISTERED_KEY, 'json')) as { at?: string; origin?: string } | null;
    if (last && typeof last.at === 'string' && last.origin === kitOrigin && now.getTime() - Date.parse(last.at) < REGISTER_EVERY_MS) return false;
    await store.put(REGISTERED_KEY, JSON.stringify({ at: now.toISOString(), origin: kitOrigin }));
    const res = await doFetch(`${mmnm}/api/v1/sellkit/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: kitOrigin }), signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}
