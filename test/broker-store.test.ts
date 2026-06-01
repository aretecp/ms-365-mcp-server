import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BrokerStore, verifyPkce, isValidCodeChallenge } from '../src/oauth/broker-store.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('BrokerStore transactions', () => {
  it('mints a state + server challenge and round-trips the transaction', () => {
    const store = new BrokerStore();
    const { challenge } = pkcePair();
    const { state, serverCodeChallenge } = store.createTransaction({
      clientId: 'mcp_abc',
      clientRedirectUri: 'http://127.0.0.1:6274/oauth/callback',
      clientState: 'client-state',
      clientCodeChallenge: challenge,
      serverRedirectUri: 'https://server/auth/callback',
    });
    expect(state).toBeTruthy();
    expect(serverCodeChallenge).toBeTruthy();
    expect(store.transactionCount()).toBe(1);

    const txn = store.consumeTransaction(state);
    expect(txn?.clientRedirectUri).toBe('http://127.0.0.1:6274/oauth/callback');
    expect(txn?.clientState).toBe('client-state');
    expect(txn?.serverRedirectUri).toBe('https://server/auth/callback');
    // The server verifier must hash to the challenge we handed Microsoft.
    const recomputed = crypto
      .createHash('sha256')
      .update(txn!.serverCodeVerifier)
      .digest('base64url');
    expect(recomputed).toBe(serverCodeChallenge);
  });

  it('consumes a transaction exactly once', () => {
    const store = new BrokerStore();
    const { challenge } = pkcePair();
    const { state } = store.createTransaction({
      clientId: null,
      clientRedirectUri: 'https://app/cb',
      clientState: null,
      clientCodeChallenge: challenge,
      serverRedirectUri: 'https://server/auth/callback',
    });
    expect(store.consumeTransaction(state)).toBeDefined();
    expect(store.consumeTransaction(state)).toBeUndefined();
  });

  it('returns undefined for an unknown state', () => {
    const store = new BrokerStore();
    expect(store.consumeTransaction('nope')).toBeUndefined();
  });
});

describe('BrokerStore authorization codes', () => {
  it('mints and consumes a single-use code carrying the session id', () => {
    const store = new BrokerStore();
    const { challenge } = pkcePair();
    const code = store.createAuthCode({
      sessionId: 'sess-123',
      clientId: 'mcp_abc',
      clientRedirectUri: 'https://app/cb',
      clientCodeChallenge: challenge,
      scope: 'Mail.Read',
    });
    expect(store.authCodeCount()).toBe(1);

    const record = store.consumeAuthCode(code);
    expect(record?.sessionId).toBe('sess-123');
    expect(record?.scope).toBe('Mail.Read');
    // Single use.
    expect(store.consumeAuthCode(code)).toBeUndefined();
  });
});

describe('verifyPkce (S256-only)', () => {
  it('accepts a matching S256 verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects a non-matching verifier', () => {
    const { challenge } = pkcePair();
    const other = pkcePair();
    expect(verifyPkce(other.verifier, challenge)).toBe(false);
  });

  it('does NOT treat the verifier as a plain challenge (no downgrade)', () => {
    // The keystone security property: a verifier equal to the challenge must
    // NOT validate. (Under a `plain` downgrade it would.)
    const { challenge } = pkcePair();
    expect(verifyPkce(challenge, challenge)).toBe(false);
  });
});

describe('isValidCodeChallenge', () => {
  it('accepts a 43-char base64url challenge', () => {
    const { challenge } = pkcePair();
    expect(challenge.length).toBeGreaterThanOrEqual(43);
    expect(isValidCodeChallenge(challenge)).toBe(true);
  });

  it('rejects empty, short, oversized, and malformed values', () => {
    expect(isValidCodeChallenge('')).toBe(false);
    expect(isValidCodeChallenge('too-short')).toBe(false);
    expect(isValidCodeChallenge('A'.repeat(129))).toBe(false);
    expect(isValidCodeChallenge('has spaces and+slashes/' + 'A'.repeat(30))).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
    expect(isValidCodeChallenge(undefined)).toBe(false);
  });
});
