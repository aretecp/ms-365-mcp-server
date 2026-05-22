import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  SessionStore,
  assertSessionKeyAvailable,
  type SessionTokens,
} from '../src/sessions/store.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function tmpDb(): string {
  return path.join(os.tmpdir(), `arete-mcp-sessions-${crypto.randomBytes(8).toString('hex')}.db`);
}

function makeKey(): Buffer {
  return crypto.randomBytes(32);
}

describe('SessionStore', () => {
  let dbPath: string;
  let store: SessionStore;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new SessionStore({ dbPath, key: makeKey() });
  });

  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* file may not exist */
    }
  });

  it('round-trips encrypted tokens through create/get', () => {
    const tokens: SessionTokens = {
      access_token: 'at-12345',
      refresh_token: 'rt-67890',
      expires_at: Date.now() + 60_000,
      scopes: 'Mail.Read User.Read',
    };
    const created = store.create(
      { tenantId: 'tenant-a', userOid: 'oid-1', userPrincipalName: 'user@example.com' },
      tokens
    );

    const fetched = store.get(created.sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.tokens).toEqual(tokens);
    expect(fetched!.userPrincipalName).toBe('user@example.com');
    expect(fetched!.tenantId).toBe('tenant-a');
  });

  it('returns null for unknown session ids without throwing', () => {
    expect(store.get('does-not-exist')).toBeNull();
  });

  it('returns null when the database holds ciphertext encrypted under a different key', () => {
    const created = store.create(
      { tenantId: 't', userOid: 'u', userPrincipalName: null },
      { access_token: 'a', refresh_token: 'r', expires_at: Date.now(), scopes: '' }
    );
    store.close();

    // Reopen with a completely different key — the GCM tag won't validate.
    const reopened = new SessionStore({ dbPath, key: makeKey() });
    expect(reopened.get(created.sessionId)).toBeNull();
    reopened.close();
  });

  it('updateTokens swaps tokens in place under the same session id', () => {
    const created = store.create(
      { tenantId: 't', userOid: 'u', userPrincipalName: null },
      { access_token: 'old', refresh_token: 'old-rt', expires_at: 0, scopes: '' }
    );
    const newer: SessionTokens = {
      access_token: 'new',
      refresh_token: 'new-rt',
      expires_at: Date.now() + 1_000_000,
      scopes: 'Mail.Read',
    };
    store.updateTokens(created.sessionId, newer);

    const fetched = store.get(created.sessionId);
    expect(fetched!.tokens).toEqual(newer);
  });

  it('delete removes the row; subsequent get returns null', () => {
    const created = store.create(
      { tenantId: 't', userOid: 'u', userPrincipalName: null },
      { access_token: 'a', refresh_token: 'r', expires_at: 0, scopes: '' }
    );
    expect(store.delete(created.sessionId)).toBe(true);
    expect(store.get(created.sessionId)).toBeNull();
    // Idempotent — second delete just returns false.
    expect(store.delete(created.sessionId)).toBe(false);
  });

  it('listByUser returns matching sessions ordered newest-first', () => {
    const idA = store.create(
      { tenantId: 't', userOid: 'u', userPrincipalName: null },
      { access_token: 'a', refresh_token: 'r', expires_at: 0, scopes: '' }
    ).sessionId;
    const idB = store.create(
      { tenantId: 't', userOid: 'u', userPrincipalName: null },
      { access_token: 'b', refresh_token: 'r', expires_at: 0, scopes: '' }
    ).sessionId;

    const sessions = store.listByUser('t', 'u');
    expect(sessions.map((s) => s.sessionId)).toEqual(expect.arrayContaining([idA, idB]));
  });
});

describe('assertSessionKeyAvailable', () => {
  const originalKey = process.env.MS365_MCP_SESSION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.MS365_MCP_SESSION_KEY;
    } else {
      process.env.MS365_MCP_SESSION_KEY = originalKey;
    }
  });

  it('throws when MS365_MCP_SESSION_KEY is missing', () => {
    delete process.env.MS365_MCP_SESSION_KEY;
    expect(() => assertSessionKeyAvailable()).toThrow(/MS365_MCP_SESSION_KEY/);
  });

  it('throws when the key decodes to the wrong length', () => {
    process.env.MS365_MCP_SESSION_KEY = Buffer.from('too-short').toString('base64');
    expect(() => assertSessionKeyAvailable()).toThrow(/32 bytes/);
  });

  it('accepts a valid 32-byte base64 key', () => {
    process.env.MS365_MCP_SESSION_KEY = crypto.randomBytes(32).toString('base64');
    expect(() => assertSessionKeyAvailable()).not.toThrow();
  });
});
