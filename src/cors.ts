// CORS for browser buyers (CORS_ORIGINS), kept on every /bundle answer.
//
// Why this exists: `paymentMiddleware` (@x402/hono) answers a failed settlement with a fresh
// Response built from x402's own headers (`c.res = undefined`, then a new Response). Hono carries
// no header over to it, so the Access-Control-* headers that `cors()` set before the paywall are
// gone, and a browser buyer sees "Failed to fetch" instead of the 402 and its reason. A refused
// signature keeps them (that answer is built through Hono); only the settle-failure path loses
// them. So after the paywall, `keepCors` puts the allowed origin and the exposed headers back.
// Pure (no Hono, no x402), so it can be tested alone.

export const ALLOW_METHODS = 'GET,OPTIONS';
export const ALLOW_HEADERS = 'PAYMENT-SIGNATURE,Content-Type';
export const EXPOSE_HEADERS = 'PAYMENT-REQUIRED,PAYMENT-RESPONSE';
/** The upload, for the hosted earn page: the visitor's own token travels from their browser to this Worker. */
export const UPLOAD_ALLOW_METHODS = 'PUT,OPTIONS';
export const UPLOAD_ALLOW_HEADERS = 'Authorization,Content-Type';

/** CORS_ORIGINS as a list of origins; empty = no CORS. */
export function allowedOrigins(value: string | undefined): string[] {
  return (value ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

/** The origin to allow for this request, or null (not allowed, or no Origin header). */
export function allowOrigin(origin: string | undefined | null, allowed: readonly string[]): string | null {
  return origin && allowed.includes(origin) ? origin : null;
}

/**
 * Sets the CORS headers for `origin` on `headers` when it is allowed (what `cors()` set before the
 * paywall), and returns whether it did. Idempotent, so it is safe on an answer that already has
 * them. `Vary: Origin` needs no help: `cors()` appends it after the paywall on every path.
 */
export function keepCors(headers: Headers, origin: string | undefined | null, allowed: readonly string[]): boolean {
  const allow = allowOrigin(origin, allowed);
  if (!allow) return false;
  headers.set('Access-Control-Allow-Origin', allow);
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  return true;
}
