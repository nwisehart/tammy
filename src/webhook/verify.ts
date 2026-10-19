// Prepcook signs each webhook delivery: `X-PrepCook-Signature` is `sha256=`
// and the lowercase hex HMAC-SHA256 of the raw request body, keyed with the
// target's secret. This is the verification Prepcook's
// docs/notifications.md gives, unchanged: compute the HMAC over the raw
// bytes received, before any JSON parsing, and compare in constant time.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyPrepCookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  );
  const received = Buffer.from(signatureHeader);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/** The header value for `rawBody`, as Prepcook computes it. */
export function signPrepCookBody(rawBody: Buffer | string, secret: string) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}
