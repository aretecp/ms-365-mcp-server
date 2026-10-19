import crypto from 'node:crypto';

const SESSION_KEY_ENV = 'MS365_MCP_SESSION_KEY';

/**
 * Loads the same key the session store / admin CSRF signing use (32 bytes
 * base64-encoded) — see `src/admin/csrf.ts::loadKey`. Reusing this existing,
 * already-required secret means a session-key rotation also invalidates
 * outstanding cursors, which is the correct failure mode (fail closed to
 * "start over"), not a new secret-management surface.
 */
function loadKey(): Buffer {
  const raw = process.env[SESSION_KEY_ENV];
  if (!raw || raw.trim() === '') {
    throw new Error(`${SESSION_KEY_ENV} is required for contacts cursor signing.`);
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`${SESSION_KEY_ENV} must decode to 32 bytes for contacts cursor signing.`);
  }
  return key;
}

/**
 * Opaque, server-issued continuation cursor for contacts list tools. Never
 * carries a bearer token or row data — only a Graph path+query Graph itself
 * returned (or that this server itself issued), plus a local integer offset.
 * Two shapes:
 *  - `nextPage`: advance to Graph's own next page, taken verbatim from a
 *    validated `@odata.nextLink` (never reconstructed from a returned count).
 *  - `withheldTail`: redeliver rows the response-size ceiling withheld from
 *    an already-fetched page, by replaying that EXACT page request again and
 *    slicing from `offset` — never re-derives a Graph-side skip.
 */
export type ContactsCursor =
  | {
      v: 1;
      tool: string;
      collectionPath: string;
      userKey: string;
      kind: 'nextPage';
      resumePath: string;
    }
  | {
      v: 1;
      tool: string;
      collectionPath: string;
      userKey: string;
      kind: 'withheldTail';
      pagePath: string;
      offset: number;
      thenResumePath?: string;
    };

/** HMAC-SHA256-signed, base64url-encoded cursor. Opaque to the caller. */
export function signCursor(payload: ContactsCursor): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', loadKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifies signature, structural shape, and binding (exact tool + exact
 * collection path + exact caller) against the current call. Returns `null`
 * — never throws — on ANY mismatch, so a forged, tampered, session-key-
 * rotated, cross-tool, cross-collection, or cross-user cursor all fail
 * closed through one uniform "invalid cursor" refusal.
 */
export function verifyCursor(
  cursor: string,
  expected: { tool: string; collectionPath: string; userKey: string }
): ContactsCursor | null {
  const dot = cursor.indexOf('.');
  if (dot <= 0 || dot === cursor.length - 1) return null;
  const body = cursor.slice(0, dot);
  const sig = cursor.slice(dot + 1);

  let key: Buffer;
  try {
    key = loadKey();
  } catch {
    return null;
  }
  const expectedSig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  const a = Buffer.from(expectedSig);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainRecord(decoded)) return null;
  if (decoded.v !== 1) return null;
  if (typeof decoded.tool !== 'string' || decoded.tool !== expected.tool) return null;
  if (
    typeof decoded.collectionPath !== 'string' ||
    decoded.collectionPath !== expected.collectionPath
  ) {
    return null;
  }
  if (typeof decoded.userKey !== 'string' || decoded.userKey !== expected.userKey) return null;

  if (decoded.kind === 'nextPage') {
    if (typeof decoded.resumePath !== 'string' || decoded.resumePath.length === 0) return null;
    return {
      v: 1,
      tool: decoded.tool,
      collectionPath: decoded.collectionPath,
      userKey: decoded.userKey,
      kind: 'nextPage',
      resumePath: decoded.resumePath,
    };
  }
  if (decoded.kind === 'withheldTail') {
    if (typeof decoded.pagePath !== 'string' || decoded.pagePath.length === 0) return null;
    if (
      typeof decoded.offset !== 'number' ||
      !Number.isInteger(decoded.offset) ||
      decoded.offset < 0
    ) {
      return null;
    }
    if (decoded.thenResumePath !== undefined && typeof decoded.thenResumePath !== 'string')
      return null;
    return {
      v: 1,
      tool: decoded.tool,
      collectionPath: decoded.collectionPath,
      userKey: decoded.userKey,
      kind: 'withheldTail',
      pagePath: decoded.pagePath,
      offset: decoded.offset,
      thenResumePath: decoded.thenResumePath,
    };
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a Graph `@odata.nextLink` against the server's configured cloud
 * endpoint (exact origin), API version, AND the exact collection path this
 * call resolved to — a same-host `nextLink` for a different Graph resource
 * (e.g. `/me/messages` instead of `/me/contacts`) must not be followed or
 * signed into a cursor, same as a different origin. Returns the validated
 * path+query with the `/v1.0` prefix stripped — the same shape
 * `graphClient.makeRequest` takes. Returns `null` on any mismatch; callers
 * must fail closed rather than silently follow an unexpected resource or
 * silently drop pagination state.
 *
 * Comparison is a plain exact string match — never case-normalized. The
 * opaque ids embedded in `collectionPath` (folder ids) are case-sensitive
 * Graph identifiers; lowercasing them could conflate two different folders.
 * `collectionPath` is always a path this server itself generated via a
 * tool's `pathResolver`, never attacker input, so a literal-route casing
 * mismatch (if Graph ever echoed one back differently) would be a Graph
 * compatibility bug to fix narrowly, not a reason to weaken this check.
 */
export function resolveTrustedNextLink(
  nextLink: string,
  graphApiBase: string,
  collectionPath: string
): string | null {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(nextLink);
    expected = new URL(graphApiBase);
  } catch {
    return null;
  }
  if (url.origin !== expected.origin) return null;
  if (!url.pathname.startsWith('/v1.0/')) return null;
  const path = url.pathname.slice('/v1.0'.length);
  if (path !== collectionPath) return null;
  return path + url.search;
}
