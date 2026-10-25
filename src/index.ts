// x402 resell worker: sells bundles you assembled, over x402, paid to YOUR wallet (PAY_TO).
// Receive-only: it holds no wallet and signs nothing. Your agent buys the inputs elsewhere (for
// example in an Open Commerce Pathways session, signing in its own wallet), turns them into a
// bundle and uploads it here; buyers pay you per read. Nothing here belongs to
// makememoneynomistakes.ai: you deploy it, you keep the income.
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createFacilitatorConfig } from '@coinbase/x402';
import { ALLOW_HEADERS, ALLOW_METHODS, allowedOrigins, allowOrigin, EXPOSE_HEADERS, keepCors } from './cors';

interface Env {
  BUNDLES: KVNamespace; // your bundles, one key per topic
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
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOPIC = /^[a-z0-9-]{1,64}$/;
const MAX_BUNDLE_BYTES = 100_000;

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
  if (env.NETWORK !== 'eip155:8453' && env.NETWORK !== 'eip155:84532') {
    throw new Error('NETWORK must be eip155:8453 (Base) or eip155:84532 (Base Sepolia)');
  }
  const charge = atomic(env.PRICE_USDC);
  if (!charge) throw new Error('PRICE_USDC must be a positive decimal like "0.02"');
  if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32) throw new Error('Set UPLOAD_TOKEN (32+ random characters) as a Worker secret');
  return charge;
}

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

// One paywall per paid route, built on its first request from the Worker's env (env is only known
// per request) and kept for the isolate's life: `GET /bundle` (the ?topic= form, or DEFAULT_TOPIC)
// and one `GET /bundle/<topic>` per bundle. The Bazaar lists a route by its bare path, query dropped,
// so `/bundle?topic=x` is never its own listing; `/bundle/x` lists each bundle on its own, with its
// own description, and that is what README step 5 pays for.
const paywalls = new Map<string, ReturnType<typeof paymentMiddleware>>();
let server: x402ResourceServer | null = null;

function paywallFor(env: Env, route: 'GET /bundle' | `GET /bundle/${string}`, topic: string): ReturnType<typeof paymentMiddleware> {
  const have = paywalls.get(route);
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
          payTo: env.PAY_TO,
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
  paywalls.set(route, made);
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

// Free: what is on sale, so buyers (and the Bazaar) can see topics and freshness before paying.
app.get('/', async (c) => {
  const list = await c.env.BUNDLES.list<{ updated_at: string }>();
  return c.json({
    service: 'x402 resell worker',
    endpoint: '/bundle/<topic>',
    endpoints: ['/bundle/<topic>', '/bundle?topic=<topic>'],
    default_topic: c.env.DEFAULT_TOPIC ?? null,
    price_usdc: c.env.PRICE_USDC,
    network: c.env.NETWORK,
    pay_to: c.env.PAY_TO,
    topics: list.keys.map((k) => ({ topic: k.name, url: `/bundle/${k.name}`, updated_at: k.metadata?.updated_at ?? null })),
  });
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
  await c.env.BUNDLES.put(topic, text, { metadata: { updated_at } });
  return c.json({ topic, updated_at, bytes: text.length });
});

/** The paywall for one request: 404 before payment for a missing or unknown topic, so nobody pays for nothing. */
async function paid(c: Context<App>, next: Next, topic: string, route: 'GET /bundle' | `GET /bundle/${string}`): Promise<Response | void> {
  if (!TOPIC.test(topic) || (await c.env.BUNDLES.get(topic)) === null) {
    return c.json({ error: 'unknown topic; GET / lists them' }, 404);
  }
  const paywall = paywallFor(c.env, route, topic);
  const res = await paywall(c, next);
  if (res && !c.finalized) c.res = res; // what Hono does with a returned Response
  // A failed settlement is answered with a fresh Response that carries none of the headers set
  // above (src/cors.ts): put the allowed origin back, or a browser buyer sees "Failed to fetch".
  keepCors(c.res.headers, c.req.header('Origin'), allowedOrigins(c.env.CORS_ORIGINS));
}

/** Runs only after the buyer's payment verified; the payment settles only on this 200. */
async function serve(c: Context<App>, topic: string): Promise<Response> {
  const hit = await c.env.BUNDLES.getWithMetadata<{ updated_at: string }>(topic);
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
