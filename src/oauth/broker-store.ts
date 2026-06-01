import crypto from 'node:crypto';
import logger from '../logger.js';

/**
 * In-memory state for the OAuth broker flow.
 *
 * The server brokers between an MCP client and Microsoft Entra so that
 * Microsoft only ever redirects back to ONE server-owned callback. Two
 * short-lived records make that work:
 *
 *  - Transaction: created at /authorize. Holds the client's redirect_uri,
 *    state, and PKCE challenge plus a fresh server↔Microsoft PKCE pair. Keyed
 *    by the `state` value we send to Microsoft, so /auth/callback can recover
 *    it from Microsoft's redirect.
 *  - AuthCode: created at /auth/callback once the session exists. Our own
 *    single-use authorization code, redeemed by the client at /token after we
 *    verify its PKCE verifier.
 *
 * Both are deliberately ephemeral: an OAuth round-trip completes in seconds,
 * and a process restart mid-flow simply asks the user to retry. Prod runs a
 * single instance, so an in-memory map is sufficient and avoids persisting
 * security-sensitive PKCE material.
 *
 * PKCE is S256-only end-to-end. The `plain` method is deliberately unsupported:
 * with `plain` the challenge equals the verifier, so anyone who can read a
 * leaked authorization code could redeem it — defeating the whole point of
 * binding the brokered code to a proof-of-possession secret. /authorize rejects
 * any method other than S256 before a transaction is ever created.
 */

const TXN_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 2000;

/** Raised when the transaction store is at capacity; callers reply 503. */
export class BrokerStoreFullError extends Error {
  constructor() {
    super('broker transaction store is at capacity');
    this.name = 'BrokerStoreFullError';
  }
}

export interface AuthTransaction {
  clientId: string | null;
  clientRedirectUri: string;
  clientState: string | null;
  /** Client's S256 PKCE challenge; verified at /token. */
  clientCodeChallenge: string;
  /** Verifier for the server's own PKCE leg against Microsoft. */
  serverCodeVerifier: string;
  /** The exact redirect_uri sent to Microsoft; reused at the token exchange. */
  serverRedirectUri: string;
  createdAt: number;
}

export interface AuthCodeRecord {
  sessionId: string;
  clientId: string | null;
  clientRedirectUri: string;
  clientCodeChallenge: string;
  scope: string;
  createdAt: number;
}

export interface CreateTransactionInput {
  clientId: string | null;
  clientRedirectUri: string;
  clientState: string | null;
  clientCodeChallenge: string;
  serverRedirectUri: string;
}

export interface CreatedTransaction {
  /** The `state` to forward to Microsoft (also the lookup key on return). */
  state: string;
  /** The PKCE challenge to forward to Microsoft. */
  serverCodeChallenge: string;
}

export interface CreateAuthCodeInput {
  sessionId: string;
  clientId: string | null;
  clientRedirectUri: string;
  clientCodeChallenge: string;
  scope: string;
}

export class BrokerStore {
  private readonly transactions = new Map<string, AuthTransaction>();
  private readonly authCodes = new Map<string, AuthCodeRecord>();

  /**
   * Drops expired entries. Called on insert only — the hot read/consume paths
   * stay O(1) rather than scanning the whole map on every request.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, txn] of this.transactions) {
      if (now - txn.createdAt > TXN_TTL_MS) this.transactions.delete(key);
    }
    for (const [key, code] of this.authCodes) {
      if (now - code.createdAt > CODE_TTL_MS) this.authCodes.delete(key);
    }
  }

  /**
   * Stores a pending authorize transaction and mints the server-side PKCE pair
   * for the Microsoft leg. Returns the `state` and `code_challenge` to forward
   * to Microsoft. Throws {@link BrokerStoreFullError} so callers can reply 503.
   */
  createTransaction(input: CreateTransactionInput): CreatedTransaction {
    this.prune();
    if (this.transactions.size >= MAX_ENTRIES) {
      logger.warn(`Broker transaction store at capacity (${MAX_ENTRIES})`);
      throw new BrokerStoreFullError();
    }

    const serverCodeVerifier = crypto.randomBytes(32).toString('base64url');
    const serverCodeChallenge = crypto
      .createHash('sha256')
      .update(serverCodeVerifier)
      .digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');

    this.transactions.set(state, {
      clientId: input.clientId,
      clientRedirectUri: input.clientRedirectUri,
      clientState: input.clientState,
      clientCodeChallenge: input.clientCodeChallenge,
      serverCodeVerifier,
      serverRedirectUri: input.serverRedirectUri,
      createdAt: Date.now(),
    });

    return { state, serverCodeChallenge };
  }

  /** Returns and removes the transaction for `state`, or undefined if unknown/expired. */
  consumeTransaction(state: string): AuthTransaction | undefined {
    const txn = this.transactions.get(state);
    if (!txn) return undefined;
    this.transactions.delete(state);
    if (Date.now() - txn.createdAt > TXN_TTL_MS) return undefined;
    return txn;
  }

  /** Mints and stores a single-use authorization code bound to a session. */
  createAuthCode(input: CreateAuthCodeInput): string {
    this.prune();
    const code = crypto.randomBytes(32).toString('base64url');
    this.authCodes.set(code, {
      sessionId: input.sessionId,
      clientId: input.clientId,
      clientRedirectUri: input.clientRedirectUri,
      clientCodeChallenge: input.clientCodeChallenge,
      scope: input.scope,
      createdAt: Date.now(),
    });
    return code;
  }

  /** Returns and removes the auth code record, or undefined if unknown/expired. */
  consumeAuthCode(code: string): AuthCodeRecord | undefined {
    const record = this.authCodes.get(code);
    if (!record) return undefined;
    this.authCodes.delete(code);
    if (Date.now() - record.createdAt > CODE_TTL_MS) return undefined;
    return record;
  }

  /** Visible for tests. */
  transactionCount(): number {
    return this.transactions.size;
  }

  /** Visible for tests. */
  authCodeCount(): number {
    return this.authCodes.size;
  }
}

/**
 * Verifies a PKCE `code_verifier` against a stored S256 `code_challenge` using
 * a length-safe, constant-time comparison. S256 only — `plain` is intentionally
 * unsupported (see the module header); callers must reject non-S256 methods at
 * /authorize so a downgraded challenge never reaches here.
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * RFC 7636 PKCE `code_challenge` (and `code_verifier`) charset/length check.
 * Base64url, 43–128 chars. Rejects empty/short/oversized/malformed values
 * before they're stored.
 */
export function isValidCodeChallenge(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}
