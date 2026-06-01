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
import { PolicyManager, Policy } from '../src/policy/index.ts';
import type { SessionManager } from '../src/sessions/manager.ts';
import type { Session } from '../src/sessions/store.ts';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function tmpPolicyFile(initial: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-mcp-admin-edit-'));
  const file = path.join(dir, 'policy.yaml');
  fs.writeFileSync(file, initial);
  return file;
}

interface Harness {
  app: express.Express;
  policyFile: string;
  policyManager: PolicyManager;
  cleanup: () => void;
  // The session id the stubbed SessionManager will recognize.
  adminSessionId: string;
  // CSRF token bound to that session id.
  csrfToken: string;
}

function buildHarness(initialYaml: string, opts: { admin?: boolean } = { admin: true }): Harness {
  const policyFile = tmpPolicyFile(initialYaml);
  const policyManager = PolicyManager.fromFile(policyFile);

  const adminSessionId = 'admin-session-' + crypto.randomBytes(4).toString('hex');
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
    policyManager,
    adminSessionId,
    csrfToken: generateCsrfToken(adminSessionId),
    cleanup: () => {
      try {
        fs.rmSync(path.dirname(policyFile), { recursive: true, force: true });
      } catch {
        /* */
      }
    },
  };
}

describe('admin policy editor', () => {
  const originalKey = process.env.MS365_MCP_SESSION_KEY;
  let harness: Harness;

  beforeEach(() => {
    process.env.MS365_MCP_SESSION_KEY = crypto.randomBytes(32).toString('base64');
  });

  afterEach(() => {
    harness?.cleanup();
    if (originalKey === undefined) delete process.env.MS365_MCP_SESSION_KEY;
    else process.env.MS365_MCP_SESSION_KEY = originalKey;
  });

  it('GET /admin/policy renders the current YAML and a CSRF token', async () => {
    harness = buildHarness('defaults:\n  allow:\n    - identity-get-me\n');
    const res = await request(harness.app)
      .get('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('defaults:');
    expect(res.text).toContain('csrf_token');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('POST /admin/policy writes the new YAML, reloads, and redirects with ?saved=1', async () => {
    harness = buildHarness('defaults:\n  allow:\n    - identity-get-me\n');
    const newYaml = 'defaults:\n  allow:\n    - identity-get-me\n    - list-mail-messages\n';
    const res = await request(harness.app)
      .post('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: harness.csrfToken, yaml: newYaml });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/policy?saved=1');

    const fileContents = fs.readFileSync(harness.policyFile, 'utf8');
    expect(fileContents).toBe(newYaml);

    // Reloaded policy reflects the new contents.
    expect(
      harness.policyManager.check({
        userPrincipalName: 'anyone@example.com',
        toolName: 'list-mail-messages',
      })
    ).toBe(true);
  });

  it('POST /admin/policy with invalid YAML re-renders with an error and leaves the file untouched', async () => {
    const originalYaml = 'defaults:\n  allow:\n    - identity-get-me\n';
    harness = buildHarness(originalYaml);
    const res = await request(harness.app)
      .post('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: harness.csrfToken, yaml: '{ not: valid: yaml\n  here' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('YAML parse error');
    expect(fs.readFileSync(harness.policyFile, 'utf8')).toBe(originalYaml);
  });

  it('POST /admin/policy with mismatched CSRF returns 403', async () => {
    const originalYaml = 'defaults:\n  allow:\n    - identity-get-me\n';
    harness = buildHarness(originalYaml);
    const res = await request(harness.app)
      .post('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: 'wrong-token', yaml: 'defaults: { allow: [identity-get-me] }' });
    expect(res.status).toBe(403);
    expect(fs.readFileSync(harness.policyFile, 'utf8')).toBe(originalYaml);
  });

  it('GET /admin/policy as a non-admin UPN returns 403', async () => {
    harness = buildHarness('defaults:\n  allow:\n    - identity-get-me\n', { admin: false });
    const res = await request(harness.app)
      .get('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`);
    expect(res.status).toBe(403);
  });

  it('GET /admin/policy without a cookie returns 401', async () => {
    harness = buildHarness('defaults:\n  allow:\n    - identity-get-me\n');
    const res = await request(harness.app).get('/admin/policy');
    expect(res.status).toBe(401);
  });

  it('Policy.fromDocument validation runs on the submitted YAML before write', async () => {
    // A YAML that is structurally a mapping but with a non-mapping top level
    // should fail validation. (Empty doc + array is the easiest to construct.)
    const originalYaml = 'defaults:\n  allow:\n    - identity-get-me\n';
    harness = buildHarness(originalYaml);
    const res = await request(harness.app)
      .post('/admin/policy')
      .set('Cookie', `${ADMIN_COOKIE_NAME}=${harness.adminSessionId}`)
      .type('form')
      .send({ csrf_token: harness.csrfToken, yaml: '- this\n- is\n- an\n- array\n' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('mapping');
    expect(fs.readFileSync(harness.policyFile, 'utf8')).toBe(originalYaml);
  });
});

// Ensure the import of Policy/PolicyManager isn't elided as unused; the tests
// above use them via the harness function above.
void Policy;
