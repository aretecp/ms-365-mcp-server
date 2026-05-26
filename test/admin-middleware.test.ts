import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import { requireAdmin, ADMIN_COOKIE_NAME, type AdminRequest } from '../src/admin/middleware.ts';
import type { Session } from '../src/sessions/store.ts';
import type { SessionManager } from '../src/sessions/manager.ts';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockRequest(cookies: Record<string, string> = {}): AdminRequest {
  return {
    cookies,
    headers: {},
    secure: false,
    get(name: string) {
      return name.toLowerCase() === 'host' ? 'localhost:3000' : undefined;
    },
  } as unknown as AdminRequest;
}

function mockResponse(): Response & {
  _status?: number;
  _body?: string;
  _headers?: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const res = {} as Response & {
    _status?: number;
    _body?: string;
    _headers?: Record<string, string>;
  };
  res._headers = headers;
  res.setHeader = ((k: string, v: string) => {
    headers[k] = v;
    return res;
  }) as Response['setHeader'];
  res.status = ((code: number) => {
    (res as { _status?: number })._status = code;
    return res;
  }) as Response['status'];
  res.type = (() => res) as Response['type'];
  res.send = ((body: string) => {
    (res as { _body?: string })._body = body;
    return res;
  }) as Response['send'];
  res.clearCookie = (() => res) as Response['clearCookie'];
  return res;
}

describe('requireAdmin middleware', () => {
  let manager: { getValidSession: ReturnType<typeof vi.fn> };
  let next: ReturnType<typeof vi.fn>;
  const allowlist = new Set(['admin@example.com']);

  beforeEach(() => {
    manager = { getValidSession: vi.fn() };
    next = vi.fn();
  });

  it('returns 401 + CSP when the cookie is missing', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await requireAdmin(manager as unknown as SessionManager, allowlist)(
      req,
      res,
      next as unknown as NextFunction
    );
    expect(res._status).toBe(401);
    expect(res._headers!['Content-Security-Policy']).toContain("default-src 'none'");
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the cookie is present but the session is unknown', async () => {
    manager.getValidSession.mockResolvedValueOnce(null);
    const req = mockRequest({ [ADMIN_COOKIE_NAME]: 'ghost' });
    const res = mockResponse();
    await requireAdmin(manager as unknown as SessionManager, allowlist)(
      req,
      res,
      next as unknown as NextFunction
    );
    expect(res._status).toBe(401);
    expect(manager.getValidSession).toHaveBeenCalledWith('ghost');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the session UPN is not in the allowlist', async () => {
    const session: Session = {
      sessionId: 'sid',
      tenantId: 't',
      userOid: 'oid',
      userPrincipalName: 'mortal@example.com',
      tokens: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: Date.now() + 1000,
        scopes: '',
      },
      createdAt: Date.now(),
    };
    manager.getValidSession.mockResolvedValueOnce(session);
    const req = mockRequest({ [ADMIN_COOKIE_NAME]: 'sid' });
    const res = mockResponse();
    await requireAdmin(manager as unknown as SessionManager, allowlist)(
      req,
      res,
      next as unknown as NextFunction
    );
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.admin and calls next when the UPN is in the allowlist (case-insensitive)', async () => {
    const session: Session = {
      sessionId: 'sid',
      tenantId: 't',
      userOid: 'oid',
      userPrincipalName: 'ADMIN@example.com',
      tokens: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: Date.now() + 1000,
        scopes: '',
      },
      createdAt: Date.now(),
    };
    manager.getValidSession.mockResolvedValueOnce(session);
    const req = mockRequest({ [ADMIN_COOKIE_NAME]: 'sid' });
    const res = mockResponse();
    await requireAdmin(manager as unknown as SessionManager, allowlist)(
      req,
      res,
      next as unknown as NextFunction
    );
    expect(next).toHaveBeenCalled();
    expect(req.admin?.upn).toBe('admin@example.com');
    expect(req.admin?.session).toBe(session);
  });
});
