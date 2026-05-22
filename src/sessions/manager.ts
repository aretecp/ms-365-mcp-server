import logger from '../logger.js';
import { refreshAccessToken } from '../lib/microsoft-auth.js';
import { getCloudEndpoints } from '../cloud-config.js';
import type { AppSecrets } from '../secrets.js';
import { SessionStore, type Session, type SessionIdentity, type SessionTokens } from './store.js';

/** Refresh the access token if it expires within this many ms. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface IdTokenClaims {
  oid?: string;
  tid?: string;
  upn?: string;
  preferred_username?: string;
  email?: string;
}

/** Parses an unverified JWT payload. Caller has already trusted the issuer (Microsoft) via OAuth. */
function decodeIdTokenClaims(idToken: string | undefined): IdTokenClaims {
  if (!idToken) return {};
  const parts = idToken.split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return {
      oid: typeof payload.oid === 'string' ? payload.oid : undefined,
      tid: typeof payload.tid === 'string' ? payload.tid : undefined,
      upn: typeof payload.upn === 'string' ? payload.upn : undefined,
      preferred_username:
        typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  } catch {
    return {};
  }
}

export interface SessionManagerOptions {
  store: SessionStore;
  secrets: AppSecrets;
}

export interface TokenResponseFromMicrosoft {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
  scope: string;
}

export class SessionManager {
  constructor(private readonly opts: SessionManagerOptions) {}

  /**
   * Persists Microsoft's token response under a new opaque session id.
   * The id_token tells us who the user is; that identity drives policy
   * lookups later.
   */
  createSession(tokens: TokenResponseFromMicrosoft): Session {
    const claims = decodeIdTokenClaims(tokens.id_token);
    if (!claims.oid || !claims.tid) {
      throw new Error(
        'Microsoft id_token is missing oid/tid claims required to identify the user.'
      );
    }
    const identity: SessionIdentity = {
      tenantId: claims.tid,
      userOid: claims.oid,
      userPrincipalName: claims.upn ?? claims.preferred_username ?? claims.email ?? null,
    };
    const sessionTokens: SessionTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      scopes: tokens.scope,
    };
    const session = this.opts.store.create(identity, sessionTokens);
    logger.info(
      `Created session for ${identity.userPrincipalName ?? identity.userOid} (tenant ${identity.tenantId})`
    );
    return session;
  }

  /**
   * Returns the up-to-date access token for a session, refreshing against
   * Microsoft when the current token is within REFRESH_SKEW_MS of expiry.
   * Returns null when the session is unknown or the refresh fails.
   */
  async getValidSession(sessionId: string): Promise<Session | null> {
    const session = this.opts.store.get(sessionId);
    if (!session) return null;

    if (session.tokens.expires_at > Date.now() + REFRESH_SKEW_MS) {
      return session;
    }

    logger.info(`Session ${sessionId.slice(0, 8)}... access token expiring; refreshing`);
    try {
      const refreshed = await refreshAccessToken(
        session.tokens.refresh_token,
        this.opts.secrets.clientId,
        this.opts.secrets.clientSecret,
        this.opts.secrets.tenantId || 'common'
      );
      const newTokens: SessionTokens = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? session.tokens.refresh_token,
        expires_at: Date.now() + refreshed.expires_in * 1000,
        scopes: refreshed.scope,
      };
      this.opts.store.updateTokens(session.sessionId, newTokens);
      return { ...session, tokens: newTokens };
    } catch (error) {
      logger.error(
        `Refresh failed for session ${sessionId.slice(0, 8)}...: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Best-effort revocation: attempts to revoke the refresh token with
   * Microsoft, then deletes the session row regardless. Microsoft's
   * `/logout` endpoint is the closest to RFC 7009 they expose.
   */
  async revokeSession(sessionId: string): Promise<boolean> {
    const session = this.opts.store.get(sessionId);
    if (!session) return false;

    try {
      const cloud = getCloudEndpoints();
      const tenantId = this.opts.secrets.tenantId || 'common';
      // Microsoft does not implement RFC 7009 token revocation. The
      // sign-out URL only invalidates browser session cookies. The
      // realistic options are: (a) delete the session locally and rely
      // on the refresh-token's natural ~90-day lifetime; (b) admin-side
      // revoke via the Graph revokeSignInSessions action. We do (a).
      await fetch(`${cloud.authority}/${tenantId}/oauth2/v2.0/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.opts.secrets.clientId }),
      }).catch((error) => {
        logger.warn(`Best-effort Microsoft logout failed: ${(error as Error).message}`);
      });
    } catch (error) {
      logger.warn(`Revocation upstream call failed: ${(error as Error).message}`);
    }

    return this.opts.store.delete(sessionId);
  }
}
