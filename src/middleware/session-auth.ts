import type { Request, Response, NextFunction } from 'express';
import logger from '../logger.js';
import { SessionManager } from '../sessions/manager.js';
import type { Session } from '../sessions/store.js';

export interface AuthenticatedRequest extends Request {
  session?: Session;
}

function buildWwwAuthenticate(req: Request, error: string, description: string): string {
  const protocol = req.secure ? 'https' : 'http';
  const origin = `${protocol}://${req.get('host')}`;
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${resourceMetadata}", error="${error}", error_description="${description}"`;
}

/**
 * Middleware factory: extracts the session_id from the bearer header,
 * loads the session via SessionManager (which refreshes the Microsoft
 * access token if needed), and attaches it to `req.session`. The MCP
 * handler then threads identity through requestContext.run(...).
 */
export function sessionAuth(sessionManager: SessionManager) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          buildWwwAuthenticate(req, 'invalid_token', 'Missing or malformed Authorization header')
        )
        .json({
          error: 'invalid_token',
          error_description: 'Missing or malformed Authorization header',
        });
      return;
    }

    const sessionId = authHeader.substring('Bearer '.length).trim();
    if (sessionId === '') {
      res
        .status(401)
        .set('WWW-Authenticate', buildWwwAuthenticate(req, 'invalid_token', 'Empty bearer token'))
        .json({ error: 'invalid_token', error_description: 'Empty bearer token' });
      return;
    }

    const session = await sessionManager.getValidSession(sessionId);
    if (!session) {
      logger.warn(
        `Rejecting MCP request with unknown or expired session ${sessionId.slice(0, 8)}...`
      );
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          buildWwwAuthenticate(req, 'invalid_token', 'Session not found or refresh failed')
        )
        .json({
          error: 'invalid_token',
          error_description: 'Session not found or refresh failed',
        });
      return;
    }

    req.session = session;
    next();
  };
}
