import express, { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import yaml from 'js-yaml';
import logger from '../logger.js';
import { getCloudEndpoints } from '../cloud-config.js';
import {
  exchangeCodeForToken,
  OAuthUpstreamError,
  toOAuthErrorResponse,
} from '../lib/microsoft-auth.js';
import type { SessionManager } from '../sessions/manager.js';
import type { PolicyManager } from '../policy/index.js';
import { Policy, type PolicyDocument } from '../policy/index.js';
import type { AppSecrets } from '../secrets.js';
import { atomicWriteSync } from './atomic-write.js';
import { generateCsrfToken, verifyCsrfToken } from './csrf.js';
import { requireAdmin, ADMIN_COOKIE_NAME, type AdminRequest } from './middleware.js';
import { ADMIN_CSP, errorPage, loginPage, policyEditorPage } from './templates.js';

const ADMIN_PKCE_TTL_MS = 10 * 60 * 1000;
const ADMIN_PKCE_MAX_ENTRIES = 256;

interface AdminPkceEntry {
  codeVerifier: string;
  createdAt: number;
}

/**
 * Browser-flow PKCE state. Unlike `PkceStore`, the admin browser is the
 * sole initiator (no MCP-client leg), so we only remember our own verifier
 * between `/admin/login` and `/admin/callback`. Keyed by OAuth `state`.
 */
class AdminPkceStore {
  private readonly entries = new Map<string, AdminPkceEntry>();

  begin(): { state: string; codeVerifier: string; codeChallenge: string } {
    const now = Date.now();
    for (const [key, value] of this.entries) {
      if (now - value.createdAt > ADMIN_PKCE_TTL_MS) this.entries.delete(key);
    }
    if (this.entries.size >= ADMIN_PKCE_MAX_ENTRIES) {
      // Drop the oldest.
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    const state = crypto.randomBytes(16).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    this.entries.set(state, { codeVerifier, createdAt: now });
    return { state, codeVerifier, codeChallenge };
  }

  consume(state: string): string | undefined {
    const entry = this.entries.get(state);
    if (!entry) return undefined;
    this.entries.delete(state);
    if (Date.now() - entry.createdAt > ADMIN_PKCE_TTL_MS) return undefined;
    return entry.codeVerifier;
  }
}

export interface AdminRouterOptions {
  sessionManager: SessionManager;
  policyManager: PolicyManager;
  policyAdmins: Set<string>;
  secrets: AppSecrets;
  /** Public origin used to build the `redirect_uri` Microsoft will call back. */
  publicBase: string | null;
}

/** Single-pod concurrent-edit guard. Second concurrent POST gets 409. */
let saveInFlight = false;

export function buildAdminRouter(opts: AdminRouterOptions): Router {
  const router = express.Router();
  const pkceStore = new AdminPkceStore();
  const guard = requireAdmin(opts.sessionManager, opts.policyAdmins);

  function adminRedirectUri(req: Request): string {
    const protocol = req.secure ? 'https' : 'http';
    const origin = opts.publicBase ?? `${protocol}://${req.get('host')}`;
    return `${origin}/admin/callback`;
  }

  // ----- GET /admin (index) -----
  router.get('/', (_req, res) => {
    res.redirect('/admin/policy');
  });

  // ----- GET /admin/login -----
  router.get('/login', (_req, res) => {
    res.setHeader('Content-Security-Policy', ADMIN_CSP);
    res.type('html').send(loginPage());
  });

  router.post('/login', (req, res) => {
    const { state, codeChallenge } = pkceStore.begin();
    const cloudEndpoints = getCloudEndpoints();
    const tenantId = opts.secrets.tenantId || 'common';
    const microsoftAuthUrl = new URL(
      `${cloudEndpoints.authority}/${tenantId}/oauth2/v2.0/authorize`
    );
    microsoftAuthUrl.searchParams.set('client_id', opts.secrets.clientId);
    microsoftAuthUrl.searchParams.set('response_type', 'code');
    microsoftAuthUrl.searchParams.set('redirect_uri', adminRedirectUri(req));
    microsoftAuthUrl.searchParams.set('response_mode', 'query');
    microsoftAuthUrl.searchParams.set(
      'scope',
      ['User.Read', 'offline_access', 'openid', 'profile', 'email'].join(' ')
    );
    microsoftAuthUrl.searchParams.set('state', state);
    microsoftAuthUrl.searchParams.set('code_challenge', codeChallenge);
    microsoftAuthUrl.searchParams.set('code_challenge_method', 'S256');
    res.redirect(microsoftAuthUrl.toString());
  });

  // The login form posts to /login, but operators landing on /admin/login
  // via a bookmark expect a button. Both paths above are wired.

  // ----- GET /admin/callback -----
  router.get('/callback', async (req, res) => {
    res.setHeader('Content-Security-Policy', ADMIN_CSP);
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;

    if (error) {
      res
        .status(400)
        .type('html')
        .send(errorPage(400, `Microsoft denied the sign-in: ${error}`));
      return;
    }
    if (!code || !state) {
      res
        .status(400)
        .type('html')
        .send(errorPage(400, 'Missing code or state parameter in the callback.'));
      return;
    }
    const codeVerifier = pkceStore.consume(state);
    if (!codeVerifier) {
      res
        .status(400)
        .type('html')
        .send(errorPage(400, 'Unknown or expired sign-in state. Start over.'));
      return;
    }

    try {
      const tokens = await exchangeCodeForToken(
        code,
        adminRedirectUri(req),
        opts.secrets.clientId,
        opts.secrets.clientSecret,
        opts.secrets.tenantId || 'common',
        codeVerifier
      );
      const session = opts.sessionManager.createSession({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        id_token: (tokens as unknown as { id_token?: string }).id_token,
        scope: tokens.scope,
      });
      res.cookie(ADMIN_COOKIE_NAME, session.sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        path: '/admin',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
      res.redirect('/admin/policy');
    } catch (err) {
      if (err instanceof OAuthUpstreamError) {
        const { status, body } = toOAuthErrorResponse(err);
        res
          .status(status)
          .type('html')
          .send(errorPage(status, `${body.error}: ${body.error_description ?? ''}`));
      } else {
        logger.error('admin callback error', err);
        res.status(500).type('html').send(errorPage(500, 'Sign-in failed.'));
      }
    }
  });

  // ----- GET /admin/logout -----
  router.get('/logout', async (req, res) => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const sessionId = cookies[ADMIN_COOKIE_NAME];
    if (sessionId) {
      await opts.sessionManager.revokeSession(sessionId).catch(() => {
        /* best-effort */
      });
    }
    res.clearCookie(ADMIN_COOKIE_NAME, { path: '/admin' });
    res.redirect('/admin/login');
  });

  // ----- GET /admin/policy -----
  router.get('/policy', guard, (req: AdminRequest, res: Response) => {
    const yamlContents = fs.readFileSync(opts.policyManager.source(), 'utf8');
    const csrfToken = generateCsrfToken(req.admin!.session.sessionId);
    const saved = req.query.saved === '1';
    res.type('html').send(
      policyEditorPage({
        yaml: yamlContents,
        upn: req.admin!.upn,
        csrfToken,
        policyPath: opts.policyManager.source(),
        saved,
        error: null,
      })
    );
  });

  // ----- POST /admin/policy -----
  router.post('/policy', guard, async (req: AdminRequest, res: Response) => {
    const submittedYaml = typeof req.body?.yaml === 'string' ? req.body.yaml : '';
    const csrfCandidate =
      typeof req.body?.csrf_token === 'string' ? req.body.csrf_token : undefined;

    if (!verifyCsrfToken(req.admin!.session.sessionId, csrfCandidate)) {
      logger.warn(`admin.policy.csrf_mismatch upn=${req.admin!.upn}`);
      res.status(403).type('html').send(errorPage(403, 'CSRF token mismatch.'));
      return;
    }

    const renderWithError = (errorMessage: string) => {
      const csrfToken = generateCsrfToken(req.admin!.session.sessionId);
      res
        .status(400)
        .type('html')
        .send(
          policyEditorPage({
            yaml: submittedYaml,
            upn: req.admin!.upn,
            csrfToken,
            policyPath: opts.policyManager.source(),
            saved: false,
            error: errorMessage,
          })
        );
    };

    let parsed: unknown;
    try {
      parsed = yaml.load(submittedYaml);
    } catch (err) {
      renderWithError(`YAML parse error: ${(err as Error).message}`);
      return;
    }
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      renderWithError('Policy file must be a YAML mapping (object).');
      return;
    }
    // Validate by trying to construct a Policy from the document. Throws on
    // structural problems we'd otherwise only see at the next reload.
    try {
      Policy.fromDocument((parsed as PolicyDocument | null) ?? {});
    } catch (err) {
      renderWithError(`Policy validation failed: ${(err as Error).message}`);
      return;
    }

    if (saveInFlight) {
      res
        .status(409)
        .type('html')
        .send(errorPage(409, 'Another save is in flight. Retry shortly.'));
      return;
    }
    saveInFlight = true;
    try {
      atomicWriteSync(opts.policyManager.source(), submittedYaml);
      const sha = crypto.createHash('sha256').update(submittedYaml, 'utf8').digest('hex');
      logger.info('policy.saved', {
        upn: req.admin!.upn,
        path: opts.policyManager.source(),
        contentSha256: sha,
        sizeBytes: Buffer.byteLength(submittedYaml, 'utf8'),
      });
      await opts.policyManager.reload();
      res.redirect('/admin/policy?saved=1');
    } catch (err) {
      logger.error('admin.policy.save_failed', err);
      renderWithError(`Save failed: ${(err as Error).message}`);
    } finally {
      saveInFlight = false;
    }
  });

  return router;
}
