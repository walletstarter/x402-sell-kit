# x402 resell worker (sell kit)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/walletstarter/x402-sell-kit)

A small Cloudflare Worker **you** deploy on **your** account. It sells JSON bundles you assembled
over x402 (`GET /bundle/<topic>`, or `GET /bundle?topic=...`), paid straight to **your** wallet.

It is receive-only: it holds no wallet and signs nothing. Your agent buys the inputs where it
already does (for example an Open Commerce Pathways session, each payment signed in its own
wallet), turns them into something worth reading, and uploads the result. Every buyer read after
that is income at no extra input cost. makememoneynomistakes.ai never sees your secrets, never
holds your money and takes no cut. Nothing here promises a sale: whether anyone pays is up to the
market.

Checked with x402 packages 2.28.0 (`@x402/hono`, `@x402/core`, `@x402/evm`, `@x402/extensions`)
and `@coinbase/x402` 2.1.0: it typechecks and bundles with `wrangler deploy --dry-run`. Run it on
Base Sepolia before real money.

## One click

The button above copies this repository into your own GitHub account, creates the KV namespace
for your bundles, asks for your receiving wallet (`PAY_TO`) and an upload token (`UPLOAD_TOKEN`),
and deploys the Worker on your Cloudflare account on Base Sepolia. From then on every push to your
copy redeploys it. Then upload a bundle (step 3) and, when you are ready for real money, set
`NETWORK` to Base and add your own CDP key (step 4). Nothing of ours is in the loop: the Worker,
the wallet and the secrets are yours. By hand instead: steps 2 to 4.

## What you need

- A Cloudflare account (Workers Free is enough to start) and Node 20+.
- **Receiving wallet** (`PAY_TO`): its public address only. This is your income. The deploy page
  asks for it; by hand it is `npx wrangler secret put PAY_TO` (a public address kept like a secret
  only so the one-click flow can ask for it).
- **Upload token** (`UPLOAD_TOKEN`): 32+ random characters, a Worker secret only your agent knows.
- For Base mainnet only: your own CDP API key (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) from the
  Coinbase Developer Platform, for the CDP facilitator. Base Sepolia uses the public
  `https://x402.org/facilitator` with no key.

## 1. Pick what to bundle

Ask the Pathways API which trusted routes your budget can afford and where buyers already spend:

```
curl "https://makememoneynomistakes.ai/api/v1/pathways/routes?budget=4"
curl "https://makememoneynomistakes.ai/api/v1/pathways?budget=4&route=<route url>"
```

Good bundles combine several sources into one answer a buyer would otherwise assemble call by
call: filtered, ranked, summarized, refreshed on a schedule. Your margin is the reads you sell
minus what the inputs cost you, so a bundle read many times beats one read once.

## 2. Deploy on Base Sepolia first

```
npm install
npx wrangler login
npx wrangler kv namespace create BUNDLES
npx wrangler secret put PAY_TO
npx wrangler secret put UPLOAD_TOKEN
npx wrangler deploy
```

Paste the KV id into `wrangler.toml` first. For local runs, copy `.dev.vars.example` to
`.dev.vars`, fill in `PAY_TO` and `UPLOAD_TOKEN` (never commit it) and run `npm run dev`.

## 3. Upload a bundle

```
curl -X PUT "https://<your-worker>.workers.dev/upload/base-usdc-daily" -H "Authorization: Bearer <UPLOAD_TOKEN>" -H "Content-Type: application/json" --data-binary "@bundle.json"
```

Topics are 1 to 64 of `a-z`, `0-9` and `-`; a bundle is JSON up to 100 KB. Upload again to refresh
it. `GET /` lists topics and when each was updated, free.

Test: `curl -i "https://<your-worker>.workers.dev/bundle/base-usdc-daily"` answers `402`
with a `PAYMENT-REQUIRED` header. Pay it with any x402 v2 client using test USDC. Unknown topics
answer 404 before any payment, and a payment settles only when the bundle is served.

Browser buyers (optional): a web page paying from the visitor's own wallet, such as
`https://app.makememoneynomistakes.ai`, needs CORS. Set `CORS_ORIGINS` to the page origins you
allow, comma-separated; `/bundle` then lets them send `PAYMENT-SIGNATURE` and read
`PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`, on every answer including a failed settlement (`src/cors.ts`
puts the headers back after the paywall, which otherwise drops them on that path). Unset, there is
no CORS and agents work as before.

## 4. Go live on Base

1. `NETWORK = "eip155:8453"` in `wrangler.toml`.
2. `npx wrangler secret put CDP_API_KEY_ID` and `npx wrangler secret put CDP_API_KEY_SECRET` (your key).
3. `npx wrangler deploy`.

## 5. List it in the x402 Bazaar

The route declares Bazaar discovery metadata (`declareDiscoveryExtension`). The CDP Bazaar indexes
a route after its first payment settled through the CDP facilitator, usually within 15 minutes.
Keep `DESCRIPTION` one plain line that describes the endpoint; the Bazaar screens out text that
instructs agents.

Two things must hold, or the payment settles and nothing is listed:

- **Pay each bundle at its own path, `/bundle/<topic>`.** Coinbase lists a route by its bare path
  with the query dropped and checks that bare URL answers 402 unpaid, so `/bundle?topic=x` can
  never be its own listing. Every bundle is sold at `/bundle/<topic>` too (same cost, its own
  description), and one settled payment to that path lists that bundle. Optional: set
  `DEFAULT_TOPIC` in `wrangler.toml` and a bare `/bundle` sells that topic and can be listed as well.
- **The first payment must echo the 402's `extensions`** (the bazaar block): this Worker forwards
  the buyer's payment to the facilitator as is. Standard x402 v2 clients do this.

Check: `curl "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=<PAY_TO>"`.
A log line `has an invalid bazaar extension: ... Code generation from strings disallowed` is a
warning only: Workers can't run the package's schema check, and the block still goes out. Once listed, our directory picks it up on its next refresh. A grade there needs a
verified ERC-8004 identity link (see https://makememoneynomistakes.ai/skill.md).

## 6. Count your income

The ledger follows wallets that paid for a Pathways run or session (that payment enrolls them).
Pay one small session from your receiving wallet, then read:

```
curl "https://makememoneynomistakes.ai/api/v1/pathways/ledger?wallet=<PAY_TO>"
```

The ledger scans Base USDC transfers to and from the wallet onchain (about every 10 minutes).
**Income is inbound x402 (EIP-3009) payments only**: plain transfers in, such as deposits from your
own wallets, show as `deposits_usdc`, never income. "Profit" appears only when the ledger's net is
positive and its coverage is current. Paying your own `PAY_TO` from your own wallets is money in a
circle, not income: don't.

## Files

- `src/index.ts`: the Worker (free topic list, token-guarded upload, the x402 paywall, the bundle).
- `src/cors.ts`: the CORS headers for browser buyers, kept on every `/bundle` answer.
- `wrangler.toml`: public config only. Secrets: `PAY_TO`, `UPLOAD_TOKEN`, and on mainnet
  `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.
- `.dev.vars.example`: the values the deploy page asks for; copy it to `.dev.vars` for local runs.
