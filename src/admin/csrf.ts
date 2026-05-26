import crypto from 'node:crypto';

const SESSION_KEY_ENV = 'MS365_MCP_SESSION_KEY';

/**
 * Loads the same key the session store uses (32 bytes base64-encoded).
 * Defers the env-var check to call time so the admin router can be built
 * before the session store's assertSessionKeyAvailable runs at boot.
 */
function loadKey(): Buffer {
  const raw = process.env[SESSION_KEY_ENV];
  if (!raw || raw.trim() === '') {
    throw new Error(`${SESSION_KEY_ENV} is required for CSRF token signing.`);
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`${SESSION_KEY_ENV} must decode to 32 bytes for CSRF signing.`);
  }
  return key;
}

/**
 * HMAC-SHA256(sessionId, MS365_MCP_SESSION_KEY) — hex-encoded.
 *
 * Embedded in the admin form as a hidden field. On POST we recompute and
 * timing-safe-compare. Because the admin session cookie is SameSite=Strict,
 * a cross-site request can't carry it; CSRF requires both the cookie and a
 * form field that the attacker can only forge with the secret.
 */
export function generateCsrfToken(sessionId: string): string {
  return crypto.createHmac('sha256', loadKey()).update(sessionId).digest('hex');
}

/**
 * Returns true iff `candidate` is the valid CSRF token for `sessionId`.
 * Never throws; malformed input returns false.
 */
export function verifyCsrfToken(sessionId: string, candidate: string | undefined): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  let expected: string;
  try {
    expected = generateCsrfToken(sessionId);
  } catch {
    return false;
  }
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
}
