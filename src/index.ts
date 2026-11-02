// x402 resell worker (sell kit v2): sells bundles you assembled, over x402, paid to YOUR wallet (PAY_TO).
// Receive-only: it holds no wallet and signs nothing. Your agent buys the inputs elsewhere (for
// example in an Open Commerce Pathways session, signing in its own wallet), turns them into a
// bundle and uploads it here; buyers pay you per read. You deploy it, you keep the income.
// v2 (2026-11-02): one read in twenty is paid to makememoneynomistakes.ai instead of you (the 5% fee;
// 0% for wallets grandfathered before the effective date), the kit registers itself so your wallet
// gets a Pathways ledger and a results row, and DISPLAY_NAME labels that row. README, "The fee".
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createFacilitatorConfig } from '@coinbase/x402';
import { ALLOW_HEADERS, ALLOW_METHODS, allowedOrigins, allowOrigin, EXPOSE_HEADERS, keepCors, UPLOAD_ALLOW_HEADERS, UPLOAD_ALLOW_METHODS } from './cors';
import { DEFAULT_MMNM_ORIGIN, FEE_TO, type FeeTerms, feeTerms, isFeeRead, KIT_VERSION, register } from './fee';
import { countSale, readCount, salesSince } from './sales';

interface Env {
  BUNDLES: KVNamespace; // your bundles, one key per topic (and the kit's own counters and cached terms)
  PAY_TO: string; // your receiving wallet (public address)
  PRICE_USDC: string; // what one bundle read costs, e.g. "0.02"
  NETWORK: string; // "eip155:84532" (Base Sepolia) to test, "eip155:8453" (Base) for real
  DESCRIPTION: string; // one plain line for the Bazaar listing
  FACILITATOR_URL?: string; // testnet default: https://x402.org/facilitator
  CDP_API_KEY_ID?: string; // secret, Base mainnet only: your own CDP key
  CDP_API_KEY_SECRET?: string; // secret, Base mainnet only
  UPLOAD_TOKEN: string; // secret: a long random string only your agent knows, for uploads
  CORS_ORIGINS?: string; // optional: comma-separated web origins whose pages may buy (browser wallets)
  DEFAULT_TOPIC?: string; // optional: the topic a bare GET /bundle serves (each bundle is also sold at /bundle/<topic>; README, step 5)
  OWN_WALLETS?: string; // optional: your own paying wallets, comma-separated; their reads are never counted as sales (README, step 7)
  DISPLAY_NAME?: string; // optional: up to 24 characters; labels your row on makememoneynomistakes.ai/results (never an address)
  MMNM_ORIGIN?: string; // optional: where the kit reads its fee terms and registers; the default is makememoneynomistakes.ai
}

interface BundleMeta {
  updated_at: string;
  reads_at_upload?: number; // the topic's sales count when it was uploaded: "sales since" counts from here
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOPIC = /^[a-z0-9-]{1,64}$/;
const MAX_BUNDLE_BYTES = 100_000;
// Every payer echoes a route's description back inside its payment, and the CDP facilitator refuses
// the whole payment when that text passes about 510 characters (measured 2026-11-02: 500 passed, 511
// did not), so a long DESCRIPTION silently fails every sale. A route adds " This route serves the
// <topic> bundle." (at most 95 characters) to it, so the configured line stops at 400.
export const DESCRIPTION_MAX = 400;

/** Decimal USDC string to 6-decimal atomic units, or null when malformed. */
function atomic(usdc: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(usdc.trim());
  if (!m) return null;
  const units = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  return units > 0n ? units : null;
}

/** Checks the config; throws with a readable reason so a bad deploy fails loud. */
function readConfig(env: Env): bigint {
  if (!ADDRESS.test(env.PAY_TO) || /^0x0{40}$/.test(env.PAY_TO)) throw new Error('PAY_TO must be your 0x wallet address');
  if (env.PAY_TO.toLowerCase() === FEE_TO.toLowerCase()) throw new Error('PAY_TO must be your own wallet, not the fee address');
  if (env.NETWORK !== 'eip155:8453' && env.NETWORK !== 'eip155:84532') {
    throw new Error('NETWORK must be eip155:8453 (Base) or eip155:84532 (Base Sepolia)');
  }
  const charge = atomic(env.PRICE_USDC);
  if (!charge) throw new Error('PRICE_USDC must be a positive decimal like "0.02"');
  if (typeof env.DESCRIPTION !== 'string' || !env.DESCRIPTION.trim()) throw new Error('DESCRIPTION must be one plain line');
  if (env.DESCRIPTION.length > DESCRIPTION_MAX) {
    throw new Error(`DESCRIPTION is ${env.DESCRIPTION.length} characters; keep it at most ${DESCRIPTION_MAX}: payers echo it back and the facilitator refuses a longer one, so every sale would fail`);
  }
  if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32) throw new Error('Set UPLOAD_TOKEN (32+ random characters) as a Worker secret');
  return charge;
}

const mmnmOrigin = (env: Env) => (env.MMNM_ORIGIN && /^https:\/\/[^/]+$/.test(env.MMNM_ORIGIN) ? env.MMNM_ORIGIN : DEFAULT_MMNM_ORIGIN);
/** DISPLAY_NAME as makememoneynomistakes.ai will accept it: 1 to 24 letters, digits, spaces and . _ ' -, not an address. */
const displayName = (env: Env): string | null => {
  const name = (env.DISPLAY_NAME ?? '').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,23}$/u.test(name) && !/^0x/i.test(name) ? name : null;
};

function facilitator(env: Env): HTTPFacilitatorClient {
  if (env.NETWORK === 'eip155:8453') {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
      throw new Error('Base mainnet needs your CDP_API_KEY_ID and CDP_API_KEY_SECRET as Worker secrets');
    }
    return new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET));
  }
  return new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || 'https://x402.org/facilitator' });
}

/** Constant-time comparison for the upload token. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type App = { Bindings: Env };
const app = new Hono<App>();

/**
 * The topic a /bundle request reads: ?topic=, else DEFAULT_TOPIC. The x402 Bazaar lists /bundle by
 * its bare path (query dropped) and only if that path answers 402 unpaid, so without a default
 * topic it answers 404 and the Worker can't be listed.
 */
const topicOf = (c: { req: { query(name: string): string | undefined }; env: Env }) => c.req.query('topic') ?? c.env.DEFAULT_TOPIC ?? '';

// One paywall per paid route and recipient, built on its first request from the Worker's env (env is
// only known per request) and kept for the isolate's life: `GET /bundle` (the ?topic= form, or
// DEFAULT_TOPIC) and one `GET /bundle/<topic>` per bundle, each in two forms: paid to you, and (one
// read in twenty, when the terms say your wallet pays the fee) paid to FEE_TO. The Bazaar lists a
// route by its bare path, query dropped, so `/bundle?topic=x` is never its own listing; `/bundle/x`
// lists each bundle on its own, with its own description, and that is what README step 5 pays for.
const paywalls = new Map<string, ReturnType<typeof paymentMiddleware>>();
let server: x402ResourceServer | null = null;

function paywallFor(env: Env, route: 'GET /bundle' | `GET /bundle/${string}`, topic: string, payTo: string): ReturnType<typeof paymentMiddleware> {
  const key = `${route}|${payTo.toLowerCase()}`;
  const have = paywalls.get(key);
  if (have) return have;
  const charge = readConfig(env);
  server ??= new x402ResourceServer(facilitator(env))
    .register(env.NETWORK as `${string}:${string}`, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const byQuery = route === 'GET /bundle';
  const made = paymentMiddleware(
    {
      [route]: {
        accepts: {
          scheme: 'exact',
          price: `$${Number(charge) / 1e6}`,
          network: env.NETWORK as `${string}:${string}`,
          payTo,
        },
        description: byQuery ? env.DESCRIPTION : `${env.DESCRIPTION} This route serves the ${topic} bundle.`,
        mimeType: 'application/json',
        extensions: {
          ...declareDiscoveryExtension({
            // The ?topic= form names the topic as a query parameter (optional: without it, /bundle
            // serves DEFAULT_TOPIC); a per-bundle path takes no input.
            input: byQuery ? { topic } : {},
            inputSchema: byQuery ? { properties: { topic: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } } } : { properties: {} },
            output: { example: { topic, updated_at: '2026-10-19T21:00:00.000Z', bundle: {} } },
          }),
        },
      },
    },
    server,
  );
  paywalls.set(key, made);
  return made;
}

// Optional: lets the web pages you list buy from a browser wallet. A page must read PAYMENT-REQUIRED
// and PAYMENT-RESPONSE and send PAYMENT-SIGNATURE. Agents and servers don't need it; unset = no CORS.
app.use('/bundle/*', async (c, next) => {
  const allowed = allowedOrigins(c.env.CORS_ORIGINS);
  if (!allowed.length) return next();
  return cors({
    origin: (origin) => allowOrigin(origin, allowed),
    allowMethods: ALLOW_METHODS.split(','),
    allowHeaders: ALLOW_HEADERS.split(','),
    exposeHeaders: EXPOSE_HEADERS.split(','),
    maxAge: 600,
  })(c, next);
});
app.use('/bundle', async (c, next) => {
  const allowed = allowedOrigins(c.env.CORS_ORIGINS);
  if (!allowed.length) return next();
  return cors({
    origin: (origin) => allowOrigin(origin, allowed),
    allowMethods: ALLOW_METHODS.split(','),
    allowHeaders: ALLOW_HEADERS.split(','),
    exposeHeaders: EXPOSE_HEADERS.split(','),
    maxAge: 600,
  })(c, next);
});

// The same origins may also read what you sell (GET /) and upload bundles from the browser (the hosted
// earn page at app.makememoneynomistakes.ai: the visitor types their own UPLOAD_TOKEN there, and it
// travels only from their browser to this Worker). Unset = no CORS, as before.
app.use('/', async (c, next) => {
  const allowed = allowedOrigins(c.env.CORS_ORIGINS);
  if (!allowed.length) return next();
  return cors({ origin: (origin) => allowOrigin(origin, allowed), allowMethods: ALLOW_METHODS.split(','), maxAge: 600 })(c, next);
});
app.use('/upload/*', async (c, next) => {
  const allowed = allowedOrigins(c.env.CORS_ORIGINS);
  if (!allowed.length) return next();
  return cors({ origin: (origin) => allowOrigin(origin, allowed), allowMethods: UPLOAD_ALLOW_METHODS.split(','), allowHeaders: UPLOAD_ALLOW_HEADERS.split(','), maxAge: 600 })(c, next);
});

/** The fee terms for your wallet (README, "The fee"): cached in KV, read from makememoneynomistakes.ai at most daily. */
const terms = (env: Env): Promise<FeeTerms> => feeTerms(env.BUNDLES, env.PAY_TO, mmnmOrigin(env));

// Free: what is on sale, so buyers (and the Bazaar) can see topics and freshness before paying. Also
// what makememoneynomistakes.ai reads when this kit registers: the wallet, the network, the version and the name.
app.get('/', async (c) => {
  const list = await c.env.BUNDLES.list<BundleMeta>();
  const fee = await terms(c.env).catch(() => null);
  return c.json({
    service: 'x402 resell worker',
    kit_version: KIT_VERSION,
    display_name: displayName(c.env),
    endpoint: '/bundle/<topic>',
    endpoints: ['/bundle/<topic>', '/bundle?topic=<topic>'],
    default_topic: c.env.DEFAULT_TOPIC ?? null,
    price_usdc: c.env.PRICE_USDC,
    network: c.env.NETWORK,
    pay_to: c.env.PAY_TO,
    fee: fee ? { one_in: fee.fee_bps > 0 ? fee.one_in : 0, grandfathered: fee.grandfathered, effective_date: fee.effective_date, fee_to: fee.fee_bps > 0 ? FEE_TO : null } : null,
    topics: list.keys
      .filter((k) => TOPIC.test(k.name)) // bundles only, not the counters or cached terms
      .map((k) => ({ topic: k.name, url: `/bundle/${k.name}`, updated_at: k.metadata?.updated_at ?? null })),
  });
});

// Yours only: settled sales per topic, in total and since the topic's last upload (README, step 7).
// Bearer UPLOAD_TOKEN. `npm run refresh-check` reads it.
app.get('/stats', async (c) => {
  readConfig(c.env);
  if (!sameToken(c.req.header('Authorization') ?? '', `Bearer ${c.env.UPLOAD_TOKEN}`)) return c.json({ error: 'unauthorized' }, 401);
  const list = await c.env.BUNDLES.list<BundleMeta>();
  const topics = [];
  for (const k of list.keys.filter((k) => TOPIC.test(k.name))) {
    const r = await readCount(c.env.BUNDLES, k.name);
    topics.push({
      topic: k.name,
      updated_at: k.metadata?.updated_at ?? null,
      reads_total: r.count,
      reads_since_update: salesSince(r.count, k.metadata?.reads_at_upload),
      fee_reads: r.fee_reads,
      last_read_at: r.last_at,
    });
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ price_usdc: c.env.PRICE_USDC, kit_version: KIT_VERSION, fee: await terms(c.env).catch(() => null), topics });
});

// Yours only: your agent uploads a bundle it assembled. Bearer UPLOAD_TOKEN.
app.put('/upload/:topic', async (c) => {
  readConfig(c.env);
  const auth = c.req.header('Authorization') ?? '';
  if (!sameToken(auth, `Bearer ${c.env.UPLOAD_TOKEN}`)) return c.json({ error: 'unauthorized' }, 401);
  const topic = c.req.param('topic');
  if (!TOPIC.test(topic)) return c.json({ error: 'topic: 1-64 of a-z, 0-9 and -' }, 400);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES) return c.json({ error: `at most ${MAX_BUNDLE_BYTES} bytes` }, 413);
  try {
    JSON.parse(text);
  } catch {
    return c.json({ error: 'the bundle must be JSON' }, 400);
  }
  const updated_at = new Date().toISOString();
  // Remember the sales count at this upload: "sales since the last refresh" counts from here.
  const meta: BundleMeta = { updated_at, reads_at_upload: (await readCount(c.env.BUNDLES, topic)).count };
  await c.env.BUNDLES.put(topic, text, { metadata: meta });
  // A kit with something to sell tells makememoneynomistakes.ai where it lives (at most weekly), in the background.
  c.executionCtx.waitUntil(register(c.env.BUNDLES, new URL(c.req.url).origin, mmnmOrigin(c.env)));
  return c.json({ topic, updated_at, bytes: text.length });
});

/** The paywall for one request: 404 before payment for a missing or unknown topic, so nobody pays for nothing. */
async function paid(c: Context<App>, next: Next, topic: string, route: 'GET /bundle' | `GET /bundle/${string}`): Promise<Response | void> {
  if (!TOPIC.test(topic) || (await c.env.BUNDLES.get(topic)) === null) {
    return c.json({ error: 'unknown topic; GET / lists them' }, 404);
  }
  // The fee (v2): when the terms say this wallet pays, one read in twenty of each topic is paid to
  // makememoneynomistakes.ai instead of you. Decided from the topic's settled count before this read.
  const fee = await terms(c.env);
  const feeRead = isFeeRead((await readCount(c.env.BUNDLES, topic)).count, fee);
  const paywall = paywallFor(c.env, route, topic, feeRead ? FEE_TO : c.env.PAY_TO);
  const res = await paywall(c, next);
  if (res && !c.finalized) c.res = res; // what Hono does with a returned Response
  // A failed settlement is answered with a fresh Response that carries none of the headers set
  // above (src/cors.ts): put the allowed origin back, or a browser buyer sees "Failed to fetch".
  keepCors(c.res.headers, c.req.header('Origin'), allowedOrigins(c.env.CORS_ORIGINS));
  // Count the sale only once it settled: a 200 carrying the facilitator's receipt.
  const receipt = c.res.headers.get('PAYMENT-RESPONSE');
  if (c.res.status === 200 && receipt) {
    c.executionCtx.waitUntil(countSale(c.env.BUNDLES, topic, receipt, c.env.OWN_WALLETS, new Date(), feeRead));
    c.executionCtx.waitUntil(register(c.env.BUNDLES, new URL(c.req.url).origin, mmnmOrigin(c.env)));
  }
}

/** Runs only after the buyer's payment verified; the payment settles only on this 200. */
async function serve(c: Context<App>, topic: string): Promise<Response> {
  const hit = await c.env.BUNDLES.getWithMetadata<BundleMeta>(topic);
  if (hit.value === null) return c.json({ error: 'unknown topic; you were not charged' }, 404);
  return c.json({ topic, updated_at: hit.metadata?.updated_at ?? null, bundle: JSON.parse(hit.value) });
}

// One path per bundle: what the Bazaar lists (README, step 5).
app.use('/bundle/:topic', (c, next) => paid(c, next, c.req.param('topic'), `GET /bundle/${c.req.param('topic')}`));
app.get('/bundle/:topic', (c) => serve(c, c.req.param('topic')));

// The ?topic= form (no topic means DEFAULT_TOPIC, when you set one).
app.use('/bundle', (c, next) => paid(c, next, topicOf(c), 'GET /bundle'));
app.get('/bundle', (c) => serve(c, topicOf(c)));

export default app;
