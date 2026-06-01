// End-to-end test of the OAuth broker: discovery -> DCR -> authorize ->
// (Microsoft) callback -> token, with Microsoft's token exchange mocked. Proves
// any client can connect with no pre-registration, and that the brokered code
// is PKCE-protected.
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  enableConsoleLogging: vi.fn(),
}));

const { exchangeCodeForToken } = vi.hoisted(() => ({ exchangeCodeForToken: vi.fn() }));
vi.mock('../src/lib/microsoft-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/microsoft-auth.js')>(
    '../src/lib/microsoft-auth.js'
  );
  return { ...actual, exchangeCodeForToken };
});

import MicrosoftGraphServer from '../src/server.js';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const CLIENT_CB = 'http://127.0.0.1:6274/oauth/callback';

function buildServer() {
  const createSession = vi.fn(() => ({ sessionId: 'sess-xyz' }));
  const sessionManager = {
    createSession,
    getValidSession: vi.fn(),
  } as unknown as ConstructorParameters<typeof MicrosoftGraphServer>[0]['sessionManager'];

  const server = new MicrosoftGraphServer({
    options: { http: '3000', publicUrl: 'https://server.test' } as never,
    secrets: { clientId: 'server-entra-client', tenantId: 'tenant-1', clientSecret: 'secret' },
    sessionManager,
    policy: {} as never,
    policyAdmins: new Set<string>(),
  });
  server.initialize('1.2.3');
  return { app: server.buildApp(), createSession };
}

describe('OAuth broker end-to-end', () => {
  beforeEach(() => {
    process.env.MS365_MCP_SESSION_DB_PATH = ':memory:';
    delete process.env.MS365_MCP_CORS_ORIGIN;
    delete process.env.MS365_MCP_ALLOWED_REDIRECT_URIS;
    exchangeCodeForToken.mockReset();
    exchangeCodeForToken.mockResolvedValue({
      access_token: 'ms-access',
      refresh_token: 'ms-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'Mail.Read openid profile User.Read offline_access',
      id_token: 'fake.id.token',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('advertises the registration endpoint in discovery metadata', async () => {
    const { app } = buildServer();
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    // registration/token endpoints are built from the request origin (the host
    // the client is talking to); authorization_endpoint uses the public base
    // because it's a browser-facing redirect target.
    expect(res.body.registration_endpoint).toMatch(/\/register$/);
    expect(res.body.token_endpoint).toMatch(/\/token$/);
    expect(res.body.authorization_endpoint).toBe('https://server.test/authorize');
  });

  it('runs the full DCR -> authorize -> callback -> token flow', async () => {
    const { app, createSession } = buildServer();

    // 1. Dynamic Client Registration — no human setup.
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB], client_name: 'MCP Jam' });
    expect(reg.status).toBe(201);
    expect(reg.body.token_endpoint_auth_method).toBe('none');
    const clientId = reg.body.client_id as string;
    expect(clientId).toMatch(/^mcp_/);

    // 2. Authorize — server should redirect to Microsoft with ITS OWN callback.
    const { verifier, challenge } = pkcePair();
    const authRes = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLIENT_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'client-state-123',
      scope: 'Mail.Read',
    });
    expect(authRes.status).toBe(302);
    const msUrl = new URL(authRes.headers.location);
    expect(msUrl.searchParams.get('client_id')).toBe('server-entra-client');
    expect(msUrl.searchParams.get('redirect_uri')).toBe('https://server.test/auth/callback');
    // Our server PKCE challenge, not the client's, goes to Microsoft.
    expect(msUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(msUrl.searchParams.get('code_challenge')).not.toBe(challenge);
    const scopes = (msUrl.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toEqual(
      expect.arrayContaining(['Mail.Read', 'openid', 'profile', 'User.Read', 'offline_access'])
    );
    const serverState = msUrl.searchParams.get('state')!;

    // 3. Microsoft redirects back to OUR callback. We exchange + mint our code.
    const cbRes = await request(app)
      .get('/auth/callback')
      .query({ code: 'ms-auth-code', state: serverState });
    expect(cbRes.status).toBe(302);
    const clientRedirect = new URL(cbRes.headers.location);
    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(CLIENT_CB);
    expect(clientRedirect.searchParams.get('state')).toBe('client-state-123');
    const ourCode = clientRedirect.searchParams.get('code')!;
    expect(ourCode).toBeTruthy();
    expect(ourCode).not.toBe('ms-auth-code');

    // The exchange used our server-owned redirect_uri + server verifier.
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(exchangeCodeForToken.mock.calls[0][1]).toBe('https://server.test/auth/callback');
    expect(createSession).toHaveBeenCalledTimes(1);

    // 4. Token — client redeems OUR code with its PKCE verifier.
    const tokenRes = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code: ourCode,
      redirect_uri: CLIENT_CB,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.access_token).toBe('sess-xyz');
    expect(tokenRes.body.token_type).toBe('Bearer');
  });

  it('rejects a token exchange with the wrong PKCE verifier', async () => {
    const { app } = buildServer();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB] });
    const clientId = reg.body.client_id as string;
    const { challenge } = pkcePair();

    const authRes = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLIENT_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    const serverState = new URL(authRes.headers.location).searchParams.get('state')!;
    const cbRes = await request(app)
      .get('/auth/callback')
      .query({ code: 'ms-auth-code', state: serverState });
    const ourCode = new URL(cbRes.headers.location).searchParams.get('code')!;

    const tokenRes = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code: ourCode,
      redirect_uri: CLIENT_CB,
      code_verifier: 'this-is-the-wrong-verifier',
      client_id: clientId,
    });
    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.error).toBe('invalid_grant');
  });

  it('rejects /authorize when the redirect_uri is not registered for the client', async () => {
    const { app } = buildServer();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB] });
    const clientId = reg.body.client_id as string;
    const { challenge } = pkcePair();

    const res = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:6274/evil',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('single-use: a brokered code cannot be redeemed twice', async () => {
    const { app } = buildServer();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB] });
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkcePair();
    const authRes = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLIENT_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    const serverState = new URL(authRes.headers.location).searchParams.get('state')!;
    const cbRes = await request(app)
      .get('/auth/callback')
      .query({ code: 'ms-auth-code', state: serverState });
    const ourCode = new URL(cbRes.headers.location).searchParams.get('code')!;

    const body = {
      grant_type: 'authorization_code',
      code: ourCode,
      redirect_uri: CLIENT_CB,
      code_verifier: verifier,
      client_id: clientId,
    };
    expect((await request(app).post('/token').send(body)).status).toBe(200);
    const second = await request(app).post('/token').send(body);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('still accepts a legacy (non-DCR) client via the env allowlist', async () => {
    process.env.MS365_MCP_ALLOWED_REDIRECT_URIS = 'https://claude.ai/api/mcp/auth_callback';
    const { app } = buildServer();
    const { challenge } = pkcePair();
    const res = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: 'some-unregistered-id',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/oauth2/v2.0/authorize');
  });

  // ---- Security regressions (from the pre-ship review) ----

  it('P0: rejects code_challenge_method=plain at /authorize', async () => {
    const { app } = buildServer();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB] });
    const clientId = reg.body.client_id as string;
    const { challenge } = pkcePair();
    const res = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLIENT_CB,
      code_challenge: challenge,
      code_challenge_method: 'plain',
      state: 's',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('P0: fails closed for an unknown client_id + arbitrary redirect when no allowlist is set', async () => {
    // beforeEach deletes MS365_MCP_ALLOWED_REDIRECT_URIS, so the legacy fallback
    // has nothing to match — an attacker redirect with no client_id must be
    // rejected rather than defaulting to "any https origin".
    const { app } = buildServer();
    const { challenge } = pkcePair();
    const res = await request(app).get('/authorize').query({
      response_type: 'code',
      redirect_uri: 'https://attacker.example/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('P1: /token rejects a DCR code when client_id is omitted', async () => {
    const { app } = buildServer();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB] });
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkcePair();
    const authRes = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLIENT_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    const serverState = new URL(authRes.headers.location).searchParams.get('state')!;
    const cbRes = await request(app)
      .get('/auth/callback')
      .query({ code: 'ms-auth-code', state: serverState });
    const ourCode = new URL(cbRes.headers.location).searchParams.get('code')!;

    // Omit client_id — must fail, not silently skip the binding.
    const noClient = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code: ourCode,
      redirect_uri: CLIENT_CB,
      code_verifier: verifier,
    });
    expect(noClient.status).toBe(400);
    expect(noClient.body.error).toBe('invalid_grant');
  });

  it('P1: /token rejects when redirect_uri is omitted', async () => {
    const { app } = buildServer();
    const reg = await request(app)
      .post('/register')
      .send({ redirect_uris: [CLIENT_CB] });
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkcePair();
    const authRes = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLIENT_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    const serverState = new URL(authRes.headers.location).searchParams.get('state')!;
    const cbRes = await request(app)
      .get('/auth/callback')
      .query({ code: 'ms-auth-code', state: serverState });
    const ourCode = new URL(cbRes.headers.location).searchParams.get('code')!;

    const noRedirect = await request(app).post('/token').send({
      grant_type: 'authorization_code',
      code: ourCode,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(noRedirect.status).toBe(400);
    expect(noRedirect.body.error).toBe('invalid_grant');
  });
});
