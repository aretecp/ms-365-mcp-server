import type { Request, Response, NextFunction } from 'express';
import logger from '../logger.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Session } from '../sessions/store.js';
import { ADMIN_CSP, errorPage } from './templates.js';

export const ADMIN_COOKIE_NAME = 'mcp_admin_session';

export interface AdminRequest extends Request {
  admin?: {
    session: Session;
    upn: string;
  };
}

/**
 * Reads the admin cookie, loads + refreshes the session via SessionManager,
 * verifies the UPN is in the admin allowlist, and attaches `req.admin` for
 * downstream handlers. All admin responses get a strict CSP header so even
 * a stored-XSS bug can't execute JavaScript.
 *
 * 401 on missing/invalid cookie. 403 on a recognized but non-admin UPN.
 */
export function requireAdmin(sessionManager: SessionManager, allowlist: Set<string>) {
  return async (req: AdminRequest, res: Response, next: NextFunction): Promise<void> => {
    res.setHeader('Content-Security-Policy', ADMIN_CSP);

    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const sessionId = cookies[ADMIN_COOKIE_NAME];
    if (!sessionId) {
      res.status(401).type('html').send(errorPage(401, 'Not signed in.'));
      return;
    }

    const session = await sessionManager.getValidSession(sessionId);
    if (!session) {
      // Cookie present but session is gone — likely after a logout / refresh failure.
      res.clearCookie(ADMIN_COOKIE_NAME, { path: '/admin' });
      res.status(401).type('html').send(errorPage(401, 'Session expired. Sign in again.'));
      return;
    }

    const upn = session.userPrincipalName?.toLowerCase() ?? '';
    if (!upn || !allowlist.has(upn)) {
      logger.warn(
        `admin.access.denied upn=${session.userPrincipalName ?? '<none>'} oid=${session.userOid}`
      );
      res
        .status(403)
        .type('html')
        .send(errorPage(403, `User '${session.userPrincipalName ?? 'unknown'}' is not an admin.`));
      return;
    }

    req.admin = { session, upn };
    next();
  };
}
