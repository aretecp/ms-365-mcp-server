import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { sessionAuth, type AuthenticatedRequest } from '../src/middleware/session-auth.js';
import type { Session } from '../src/sessions/store.js';
import type { SessionManager } from '../src/sessions/manager.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockRequest(headers: Record<string, string> = {}): AuthenticatedRequest {
  return {
    headers,
    secure: false,
    get(name: string) {
      return name.toLowerCase() === 'host' ? 'localhost:3000' : undefined;
    },
  } as unknown as AuthenticatedRequest;
}

function mockResponse(): Response & { _status?: number; _body?: unknown; _www?: string } {
  const res = {} as Response & {
    _status?: number;
    _body?: unknown;
    _www?: string;
    statusCalled?: boolean;
  };
  res.status = ((code: number) => {
    (res as { _status?: number })._status = code;
    return res;
  }) as Response['status'];
  res.set = ((name: string, value: string) => {
    if (name === 'WWW-Authenticate') (res as { _www?: string })._www = value;
    return res;
  }) as Response['set'];
  res.json = ((body: unknown) => {
    (res as { _body?: unknown })._body = body;
    return res;
  }) as Response['json'];
  return res;
}

describe('sessionAuth middleware', () => {
  let manager: { getValidSession: ReturnType<typeof vi.fn> };
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = { getValidSession: vi.fn() };
    next = vi.fn();
  });

  afterEach(() => vi.clearAllMocks());

  it('rejects requests without a bearer header', async () => {
    const req = mockRequest();
    const res = mockResponse();
    const middleware = sessionAuth(manager as unknown as SessionManager);
    await middleware(req, res, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: string }).error).toBe('invalid_token');
    expect(res._www).toContain('Bearer');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an empty bearer token', async () => {
    const req = mockRequest({ authorization: 'Bearer ' });
    const res = mockResponse();
    await sessionAuth(manager as unknown as SessionManager)(req, res, next);
    expect(res._status).toBe(401);
    expect((res._body as { error_description: string }).error_description).toContain('Empty');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the session is unknown', async () => {
    manager.getValidSession.mockResolvedValueOnce(null);
    const req = mockRequest({ authorization: 'Bearer ghost' });
    const res = mockResponse();
    await sessionAuth(manager as unknown as SessionManager)(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(manager.getValidSession).toHaveBeenCalledWith('ghost');
  });

  it('attaches the session and calls next on a valid bearer', async () => {
    const session: Session = {
      sessionId: 'sid',
      tenantId: 'tenant',
      userOid: 'oid',
      userPrincipalName: 'u@example.com',
      tokens: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: Date.now() + 1000,
        scopes: '',
      },
      createdAt: Date.now(),
    };
    manager.getValidSession.mockResolvedValueOnce(session);
    const req = mockRequest({ authorization: 'Bearer sid' });
    const res = mockResponse();
    await sessionAuth(manager as unknown as SessionManager)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.session).toBe(session);
    expect(res._status).toBeUndefined();
  });
});
