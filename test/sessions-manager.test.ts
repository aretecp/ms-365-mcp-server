import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../src/sessions/store.js';
import { SessionManager } from '../src/sessions/manager.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { refreshAccessToken } = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(),
}));
vi.mock('../src/lib/microsoft-auth.js', () => ({ refreshAccessToken }));

function tmpDb(): string {
  return path.join(os.tmpdir(), `arete-mcp-sessions-${crypto.randomBytes(8).toString('hex')}.db`);
}

function makeIdToken(claims: {
  oid?: string;
  tid?: string;
  upn?: string;
  preferred_username?: string;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  // signature segment intentionally empty — manager only decodes, doesn't verify
  return `${header}.${payload}.`;
}

describe('SessionManager', () => {
  let dbPath: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    refreshAccessToken.mockReset();
    dbPath = tmpDb();
    store = new SessionStore({ dbPath, key: crypto.randomBytes(32) });
    manager = new SessionManager({
      store,
      secrets: { clientId: 'cid', tenantId: 'tid', clientSecret: undefined },
    });
  });

  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* */
    }
  });

  it('createSession extracts identity from the id_token', () => {
    const id_token = makeIdToken({ oid: 'oid-1', tid: 'tenant-a', upn: 'user@example.com' });
    const session = manager.createSession({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token,
      scope: 'Mail.Read',
    });
    expect(session.userOid).toBe('oid-1');
    expect(session.tenantId).toBe('tenant-a');
    expect(session.userPrincipalName).toBe('user@example.com');
  });

  it('createSession falls back to preferred_username when upn is missing', () => {
    const id_token = makeIdToken({
      oid: 'oid-2',
      tid: 't',
      preferred_username: 'pref@example.com',
    });
    const session = manager.createSession({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token,
      scope: '',
    });
    expect(session.userPrincipalName).toBe('pref@example.com');
  });

  it('createSession refuses tokens whose id_token has no oid/tid', () => {
    const id_token = makeIdToken({});
    expect(() =>
      manager.createSession({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        id_token,
        scope: '',
      })
    ).toThrow(/oid\/tid/);
  });

  it('getValidSession returns the existing tokens when the access token is still fresh', async () => {
    const id_token = makeIdToken({ oid: 'oid', tid: 't', upn: 'u@e.com' });
    const created = manager.createSession({
      access_token: 'still-fresh',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token,
      scope: '',
    });
    const session = await manager.getValidSession(created.sessionId);
    expect(session?.tokens.access_token).toBe('still-fresh');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('getValidSession refreshes when the access token is within the skew window', async () => {
    const id_token = makeIdToken({ oid: 'oid', tid: 't', upn: 'u@e.com' });
    const created = manager.createSession({
      access_token: 'about-to-expire',
      refresh_token: 'rt-original',
      expires_in: 10, // 10 seconds — well within the 5-minute refresh skew
      id_token,
      scope: 'Mail.Read',
    });

    refreshAccessToken.mockResolvedValueOnce({
      access_token: 'fresh-at',
      refresh_token: 'rt-rotated',
      expires_in: 3600,
      scope: 'Mail.Read',
    });

    const session = await manager.getValidSession(created.sessionId);
    expect(session?.tokens.access_token).toBe('fresh-at');
    expect(session?.tokens.refresh_token).toBe('rt-rotated');
    expect(refreshAccessToken).toHaveBeenCalledWith('rt-original', 'cid', undefined, 'tid');

    // Persisted to the store with the new tokens.
    const reread = store.get(created.sessionId);
    expect(reread?.tokens.access_token).toBe('fresh-at');
  });

  it('getValidSession returns null when refresh fails so callers surface 401', async () => {
    const id_token = makeIdToken({ oid: 'oid', tid: 't', upn: 'u@e.com' });
    const created = manager.createSession({
      access_token: 'expired',
      refresh_token: 'rt',
      expires_in: 0,
      id_token,
      scope: '',
    });
    refreshAccessToken.mockRejectedValueOnce(new Error('AADSTS70008: refresh token expired'));
    const session = await manager.getValidSession(created.sessionId);
    expect(session).toBeNull();
  });

  it('revokeSession deletes the row even if the upstream logout call rejects', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network down'));
    const id_token = makeIdToken({ oid: 'oid', tid: 't', upn: 'u@e.com' });
    const created = manager.createSession({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token,
      scope: '',
    });
    const ok = await manager.revokeSession(created.sessionId);
    expect(ok).toBe(true);
    expect(store.get(created.sessionId)).toBeNull();
    fetchMock.mockRestore();
  });

  it('revokeSession returns false when the session does not exist', async () => {
    expect(await manager.revokeSession('never-existed')).toBe(false);
  });
});
