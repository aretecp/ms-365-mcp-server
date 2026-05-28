/**
 * Integration tests for GET /admin/dashboard.
 * Mirrors patterns from test/admin-policy-edit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAdminRouter } from '../src/admin/router.ts';
import { ADMIN_COOKIE_NAME } from '../src/admin/middleware.ts';
import { generateCsrfToken } from '../src/admin/csrf.ts';
import { PolicyManager } from '../src/policy/index.ts';
import type { SessionManager } from '../src/sessions/manager.ts';
import type { Session } from '../src/sessions/store.ts';
import { toolCallLog, type ToolCallEntry } from '../src/admin/tool-call-log.ts';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function tmpPolicyFile(initial: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-mcp-admin-dash-'));
  const file = path.join(dir, 'policy.yaml');
  fs.writeFileSync(file, initial);
  return file;
}

interface Harness {
  app: express.Express;
  policyFile: string;
  cleanup: () => void;
  adminSessionId: string;
  sessionManager: SessionManager;
}

function buildHarness(opts: { admin?: boolean } = { admin: true }): Harness {
  const policyFile = tmpPolicyFile('defaults:\n  allow:\n    - get-me\n');
  const policyManager = PolicyManager.fromFile(policyFile);

  const adminSessionId = 'dash-session-' + crypto.randomBytes(4).toString('hex');
  const stubSession: Session = {
    sessionId: adminSessionId,
    tenantId: 't',
    userOid: 'oid',
    userPrincipalName: opts.admin ? 'admin@example.com' : 'mortal@example.com',
    tokens: {
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() + 600_000,
      scopes: '',
    },
    createdAt: Date.now(),
  };
  const sessionManager = {
    getValidSession: vi.fn(async (sid: string) => (sid === adminSessionId ? stubSession : null)),
    createSession: vi.fn(),
    revokeSession: vi.fn().mockResolvedValue(true),
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(
    '/admin',
    buildAdminRouter({
      sessionManager,
      policyManager,
      policyAdmins: new Set(['admin@example.com']),
      secrets: { clientId: 'cid', tenantId: 'tid' },
      publicBase: null,
    })
  );

  return {
    app,
    policyFile,
    adminSessionId,
    sessionManager,
    cleanup: () => {
      try {
        fs.rmSync(path.dirname(policyFile), { recursive: true, force: true });
      } catch {
        /* */
      }
    },
  };
}

function makeEntry(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    upn: 'user@example.com',
    toolName: 'get-me',
    status: 'allowed',
    latencyMs: 10,
    argsExcerpt: '{}',
    responseExcerpt: '{"id":"me"}',
    errorText: null,
    ...overrides,
  };
}

describe('GET /admin/dashboard', () => {
  const originalKey = process.env.MS365_MCP_SESSION_KEY;
  let harness: Harness;

  beforeEach(() => {
    process.env.MS365_MCP_SESSION_KEY = crypto.randomBytes(32).toString('base64');
    toolCallLog.clear();
  });

  afterEach(() => {
    harness?.cleanup();
    toolCallLog.clear();
    if (originalKey === undefined) delete process.env.MS365_MCP_SESSION_KEY;
    else process.env.MS365_MCP_SESSION_KEY = originalKey;
  });

  it('returns 401 when no cookie is present', async () => {
    harness = buildHarness();
    const res = await request(harness.app).get('/admin/dashboard');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin UPN', async () => {
    harness = buildHarness({ admin: false });
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);
    expect(res.status).toBe(403);
  });

  it('renders the dashboard for an admin with an empty log', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.text).toContain('Dashboard');
    expect(res.text).toContain('admin@example.com');
    expect(res.text).toContain('No tool calls recorded yet');
  });

  it('renders a row for each logged tool call', async () => {
    toolCallLog.record(makeEntry({ toolName: 'list-mail-messages', status: 'allowed' }));
    toolCallLog.record(makeEntry({ toolName: 'send-mail', status: 'denied_by_policy' }));

    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('list-mail-messages');
    expect(res.text).toContain('send-mail');
    expect(res.text).toContain('denied by policy');
    expect(res.text).toContain('allowed');
  });

  it('filters rows by status query param', async () => {
    toolCallLog.record(makeEntry({ toolName: 'allowed-tool', status: 'allowed' }));
    toolCallLog.record(makeEntry({ toolName: 'denied-tool', status: 'denied_by_policy' }));

    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard?status=denied_by_policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('denied-tool');
    expect(res.text).not.toContain('allowed-tool');
  });

  it('shows all rows when filter is cleared (status param missing)', async () => {
    toolCallLog.record(makeEntry({ toolName: 'tool-a', status: 'allowed' }));
    toolCallLog.record(makeEntry({ toolName: 'tool-b', status: 'graph_error' }));

    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('tool-a');
    expect(res.text).toContain('tool-b');
  });

  it('sort=latencyMs&order=asc sorts ascending by latency', async () => {
    toolCallLog.record(makeEntry({ toolName: 'slow-tool', latencyMs: 500 }));
    toolCallLog.record(makeEntry({ toolName: 'fast-tool', latencyMs: 5 }));
    toolCallLog.record(makeEntry({ toolName: 'medium-tool', latencyMs: 100 }));

    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard?sort=latencyMs&order=asc')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    const fastPos = res.text.indexOf('fast-tool');
    const medPos = res.text.indexOf('medium-tool');
    const slowPos = res.text.indexOf('slow-tool');
    expect(fastPos).toBeLessThan(medPos);
    expect(medPos).toBeLessThan(slowPos);
  });

  it('sort=latencyMs&order=desc sorts descending by latency', async () => {
    toolCallLog.record(makeEntry({ toolName: 'slow-tool', latencyMs: 500 }));
    toolCallLog.record(makeEntry({ toolName: 'fast-tool', latencyMs: 5 }));

    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard?sort=latencyMs&order=desc')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    const fastPos = res.text.indexOf('fast-tool');
    const slowPos = res.text.indexOf('slow-tool');
    expect(slowPos).toBeLessThan(fastPos);
  });

  it('invalid sort column falls back to ts sort', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard?sort=injected&order=desc')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);
    // Should render without error
    expect(res.status).toBe(200);
  });

  it('shows expanded details block with argsExcerpt and errorText', async () => {
    toolCallLog.record(
      makeEntry({
        toolName: 'bad-tool',
        status: 'graph_error',
        argsExcerpt: '{"message-id":"abc"}',
        errorText: 'Something went wrong',
        responseExcerpt: null,
      })
    );

    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<details>');
    expect(res.text).toContain('args:');
    expect(res.text).toContain('message-id');
    expect(res.text).toContain('error:');
    expect(res.text).toContain('Something went wrong');
  });

  it('GET /admin/ redirects to /admin/dashboard', async () => {
    harness = buildHarness();
    const res = await request(harness.app).get('/admin/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/dashboard');
  });

  it('renders the header bar with sign-out form on the policy page', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('header-bar');
    expect(res.text).toContain('/admin/logout');
    expect(res.text).toContain('admin@example.com');
  });

  it('renders the policy summary card with default allow tools', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    // The harness initialises with defaults.allow = [get-me]
    expect(res.text).toContain('Policy summary');
    expect(res.text).toContain('Default allow');
    expect(res.text).toContain('get-me');
    expect(res.text).toContain('Edit YAML');
  });

  it('shows "No per-user overrides" when no user entries exist', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .get('/admin/dashboard')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('No per-user overrides');
  });
});

describe('POST /admin/logout', () => {
  const originalKey = process.env.MS365_MCP_SESSION_KEY;
  let harness: Harness;

  beforeEach(() => {
    process.env.MS365_MCP_SESSION_KEY = crypto.randomBytes(32).toString('base64');
    toolCallLog.clear();
  });

  afterEach(() => {
    harness?.cleanup();
    toolCallLog.clear();
    if (originalKey === undefined) delete process.env.MS365_MCP_SESSION_KEY;
    else process.env.MS365_MCP_SESSION_KEY = originalKey;
  });

  it('POST with valid CSRF redirects to /admin/login and clears the cookie', async () => {
    harness = buildHarness();
    const csrfToken = generateCsrfToken(harness.adminSessionId);
    const res = await request(harness.app)
      .post('/admin/logout')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: csrfToken });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
    // Cookie should be cleared (Set-Cookie header present with empty or past-expiry value)
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
    expect(cookieHeader).toContain(ADMIN_COOKIE_NAME);
  });

  it('POST with valid CSRF calls sessionManager.revokeSession', async () => {
    harness = buildHarness();
    const csrfToken = generateCsrfToken(harness.adminSessionId);
    await request(harness.app)
      .post('/admin/logout')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: csrfToken });

    expect(
      (harness.sessionManager as unknown as { revokeSession: ReturnType<typeof vi.fn> })
        .revokeSession
    ).toHaveBeenCalledWith(harness.adminSessionId);
  });

  it('POST without CSRF token returns 403', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .post('/admin/logout')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: 'bad-token' });

    expect(res.status).toBe(403);
  });

  it('POST without session cookie returns 403', async () => {
    harness = buildHarness();
    const res = await request(harness.app)
      .post('/admin/logout')
      .type('form')
      .send({ csrf_token: 'irrelevant' });

    expect(res.status).toBe(403);
  });

  it('GET /admin/logout returns 405', async () => {
    harness = buildHarness();
    const res = await request(harness.app).get('/admin/logout');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });
});
