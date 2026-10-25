#!/usr/bin/env node
// npm run refresh-check -- --worker https://<your-worker>.workers.dev [--costs refresh-costs.json]
//
// The refresh-when-paid rule (README, step 7): a bundle is worth refreshing only after its own sales
// since its last upload have paid for that refresh. Reads your Worker's private /stats (settled sales
// only, your OWN_WALLETS never counted) and refresh-costs.json (what one refresh of each topic costs
// you in USDC), and says REFRESH or waiting per topic. It reads and prints; it never pays for anything.
//
// The upload token comes from the UPLOAD_TOKEN environment variable, else from .dev.vars. It is sent
// only to your Worker and never printed. The Worker URL can also come from WORKER_URL.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Decimal USDC to 6-decimal atomic units (bigint), or null when malformed. "0" is allowed. */
export function usdcUnits(v) {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(String(v ?? '').trim());
  return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0')) : null;
}

/** Atomic units back to a short dollar string. */
export function usd(units) {
  const n = Number(units) / 1e6;
  const s = n.toFixed(6).replace(/0+$/, ''); // at least two decimals, up to six
  return `$${(s.split('.')[1] ?? '').length < 2 ? n.toFixed(2) : s}`;
}

/**
 * One verdict per topic, from /stats and the costs file ({ "<topic>": "<USDC>" }).
 * due = sales since the last upload x the read charge >= that topic's refresh cost.
 */
export function decide(stats, costs) {
  const unit = usdcUnits(stats?.price_usdc);
  if (unit === null || unit === 0n) throw new Error('the Worker did not report a usable price_usdc');
  const onSale = new Map((stats.topics ?? []).map((t) => [t.topic, t]));
  const rows = [];
  for (const [topic, t] of onSale) {
    const sales = Number.isInteger(t.reads_since_update) && t.reads_since_update > 0 ? t.reads_since_update : 0;
    const earned = BigInt(sales) * unit;
    if (!(topic in costs)) {
      rows.push({ topic, sales, earned, cost: null, due: false, note: 'no refresh cost set: add it to refresh-costs.json' });
      continue;
    }
    const cost = usdcUnits(costs[topic]);
    if (cost === null) {
      rows.push({ topic, sales, earned, cost: null, due: false, note: `refresh cost "${costs[topic]}" is not a USDC amount` });
      continue;
    }
    const due = earned >= cost;
    rows.push({ topic, sales, earned, cost, due, note: due ? 'REFRESH' : 'waiting' });
  }
  for (const topic of Object.keys(costs)) {
    if (!onSale.has(topic)) rows.push({ topic, sales: 0, earned: 0n, cost: usdcUnits(costs[topic]), due: false, note: 'not on sale yet: upload it first' });
  }
  return { unit, rows };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function uploadToken() {
  if (process.env.UPLOAD_TOKEN) return process.env.UPLOAD_TOKEN.trim();
  if (!existsSync('.dev.vars')) return '';
  const line = readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((l) => /^\s*UPLOAD_TOKEN\s*=/.test(l));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^"(.*)"$/, '$1') : '';
}

async function main() {
  const worker = (arg('worker') ?? process.env.WORKER_URL ?? '').replace(/\/+$/, '');
  const costsFile = arg('costs') ?? 'refresh-costs.json';
  if (!/^https?:\/\/[^/]+$/.test(worker)) throw new Error('give your Worker as --worker https://<your-worker>.workers.dev');
  if (!existsSync(costsFile)) throw new Error(`no ${costsFile}: copy refresh-costs.example.json to it and fill in your topics`);
  const costs = JSON.parse(readFileSync(costsFile, 'utf8'));
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) throw new Error(`${costsFile} must be an object of "<topic>": "<USDC>"`);
  const token = uploadToken();
  if (token.length < 32) throw new Error('set UPLOAD_TOKEN (environment variable or .dev.vars) to your Worker secret');

  const res = await fetch(`${worker}/stats`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('the Worker refused the upload token (401)');
  if (!res.ok) throw new Error(`${worker}/stats answered ${res.status}`);
  const { unit, rows } = decide(await res.json(), costs);

  console.log(`Sales since each bundle's last upload (${usd(unit)} a read):`);
  for (const r of rows) {
    const money = r.cost === null ? `${usd(r.earned)} earned` : `${usd(r.earned)} of the ${usd(r.cost)} a refresh costs`;
    console.log(`  ${r.topic}: ${r.sales} sale(s) = ${money}: ${r.note}`);
  }
  const due = rows.filter((r) => r.due).map((r) => r.topic);
  console.log(due.length
    ? `Refresh now: ${due.join(', ')}. Upload each one again afterwards; that resets its count.`
    : 'Nothing has paid for its refresh yet. Spend nothing; every bundle stays on sale.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`refresh-check: ${e.message}`);
    process.exit(1);
  });
}
