import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import logger, { enableConsoleLogging } from './logger.js';
import { registerTools } from './tool-runtime.js';
import { buildMcpServerInstructions } from './mcp-instructions.js';
import GraphClient from './graph-client.js';
import { resolveAuthScopes } from './oauth/scopes.js';
import {
  exchangeCodeForToken,
  OAuthUpstreamError,
  toOAuthErrorResponse,
} from './lib/microsoft-auth.js';
import { isAllowedRedirectUri, parseAllowlist } from './lib/redirect-uri-validation.js';
import type { CommandOptions } from './cli.ts';
import { AppSecrets } from './secrets.js';
import { getCloudEndpoints } from './cloud-config.js';
import { requestContext } from './request-context.js';
import { PkceStore } from './oauth/pkce-store.js';
import type { SessionManager } from './sessions/manager.js';
import { sessionAuth, type AuthenticatedRequest } from './middleware/session-auth.js';
import type { Policy } from './policy/index.js';

/**
 * Parse HTTP option into host and port components.
 * Supports formats: "host:port", ":port", "port"
 */
function parseHttpOption(httpOption: string | boolean): { host: string | undefined; port: number } {
  if (typeof httpOption === 'boolean') {
    return { host: undefined, port: 3000 };
  }

  const httpString = httpOption.trim();

  if (httpString.includes(':')) {
    const [hostPart, portPart] = httpString.split(':');
    const host = hostPart || undefined;
    const port = parseInt(portPart) || 3000;
    return { host, port };
  }

  const port = parseInt(httpString) || 3000;
  return { host: undefined, port };
}

export interface MicrosoftGraphServerDeps {
  options: CommandOptions;
  secrets: AppSecrets;
  sessionManager: SessionManager;
  policy: Policy;
}

class MicrosoftGraphServer {
  private readonly options: CommandOptions;
  private readonly secrets: AppSecrets;
  private readonly sessionManager: SessionManager;
  private readonly policy: Policy;
  private readonly graphClient: GraphClient;
  private readonly pkceStore = new PkceStore();
  private version: string = '0.0.0';

  constructor(deps: MicrosoftGraphServerDeps) {
    this.options = deps.options;
    this.secrets = deps.secrets;
    this.sessionManager = deps.sessionManager;
    this.policy = deps.policy;
    this.graphClient = new GraphClient(this.options.toon ? 'toon' : 'json');
  }

  initialize(version: string): void {
    this.version = version;
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      {
        name: 'AreteM365MCP',
        version: this.version,
      },
      {
        instructions: buildMcpServerInstructions({ multiAccount: false }),
      }
    );

    registerTools(server, this.graphClient, { policy: this.policy });

    return server;
  }

  async start(): Promise<void> {
    if (this.options.v) {
      enableConsoleLogging();
    }

    logger.info('Areté Microsoft 365 MCP Server starting...');
    logger.info('Secrets Check:', {
      CLIENT_ID: this.secrets.clientId ? `${this.secrets.clientId.substring(0, 8)}...` : 'NOT SET',
      CLIENT_SECRET: this.secrets.clientSecret ? 'SET' : 'NOT SET',
      TENANT_ID: this.secrets.tenantId || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV || 'NOT SET',
    });

    if (!this.options.http) {
      throw new Error(
        'The Areté MCP server only runs over HTTP. Start with --http [host:]port (e.g. --http 3000 or --http localhost:3000).'
      );
    }

    const { host, port } = parseHttpOption(this.options.http);

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const corsOrigin = process.env.MS365_MCP_CORS_ORIGIN || 'http://localhost:3000';
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', corsOrigin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-protocol-version'
      );
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }
      next();
    });

    // Public URL for browser-facing OAuth redirects when behind a reverse proxy.
    const publicUrlRaw = this.options.publicUrl || process.env.MS365_MCP_PUBLIC_URL || null;
    const publicBase = publicUrlRaw ? new URL(publicUrlRaw).href.replace(/\/$/, '') : null;

    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const protocol = req.secure ? 'https' : 'http';
      const requestOrigin = `${protocol}://${req.get('host')}`;
      const browserBase = publicBase ?? requestOrigin;

      res.json({
        issuer: browserBase,
        authorization_endpoint: `${browserBase}/authorize`,
        token_endpoint: `${requestOrigin}/token`,
        revocation_endpoint: `${requestOrigin}/revoke`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: resolveAuthScopes(),
      });
    });

    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      const protocol = req.secure ? 'https' : 'http';
      const requestOrigin = `${protocol}://${req.get('host')}`;
      const browserBase = publicBase ?? requestOrigin;

      res.json({
        resource: `${requestOrigin}/mcp`,
        authorization_servers: [browserBase],
        scopes_supported: resolveAuthScopes(),
        bearer_methods_supported: ['header'],
        resource_documentation: browserBase,
      });
    });

    app.get('/authorize', async (req, res) => {
      const url = new URL(req.url!, `${req.protocol}://${req.get('host')}`);
      const tenantId = this.secrets.tenantId || 'common';
      const clientId = this.secrets.clientId;
      const cloudEndpoints = getCloudEndpoints();
      const microsoftAuthUrl = new URL(
        `${cloudEndpoints.authority}/${tenantId}/oauth2/v2.0/authorize`
      );

      const clientCodeChallenge = url.searchParams.get('code_challenge');
      const clientCodeChallengeMethod = url.searchParams.get('code_challenge_method');
      const state = url.searchParams.get('state');

      // CWE-601 redirect_uri allowlist.
      const redirectUriParam = url.searchParams.get('redirect_uri');
      if (redirectUriParam) {
        const allowlist = parseAllowlist(process.env.MS365_MCP_ALLOWED_REDIRECT_URIS);
        if (!isAllowedRedirectUri(redirectUriParam, allowlist)) {
          logger.warn('Rejected /authorize request with disallowed redirect_uri', {
            redirect_uri: redirectUriParam,
          });
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'redirect_uri is not allowed',
          });
          return;
        }
      }

      const allowedParams = [
        'response_type',
        'redirect_uri',
        'scope',
        'state',
        'response_mode',
        'prompt',
        'login_hint',
        'domain_hint',
      ];
      allowedParams.forEach((param) => {
        const value = url.searchParams.get(param);
        if (value) microsoftAuthUrl.searchParams.set(param, value);
      });

      if (clientCodeChallenge && state) {
        try {
          const { serverCodeChallenge } = this.pkceStore.registerClientChallenge({
            state,
            clientCodeChallenge,
            clientCodeChallengeMethod: clientCodeChallengeMethod ?? 'S256',
          });
          microsoftAuthUrl.searchParams.set('code_challenge', serverCodeChallenge);
          microsoftAuthUrl.searchParams.set('code_challenge_method', 'S256');
          logger.info('Two-leg PKCE: stored client challenge, generated server challenge', {
            state: state.substring(0, 8) + '...',
          });
        } catch (error) {
          if ((error as Error).message === 'pkce_store_full') {
            res.status(503).json({
              error: 'server_busy',
              error_description: 'Too many pending authorization requests. Try again later.',
            });
            return;
          }
          throw error;
        }
      } else if (clientCodeChallenge) {
        // No state — forward client challenge directly.
        microsoftAuthUrl.searchParams.set('code_challenge', clientCodeChallenge);
        if (clientCodeChallengeMethod) {
          microsoftAuthUrl.searchParams.set('code_challenge_method', clientCodeChallengeMethod);
        }
      }

      microsoftAuthUrl.searchParams.set('client_id', clientId);

      // Inject User.Read + offline_access silently (needed for /me access + refresh tokens).
      const clientScope = microsoftAuthUrl.searchParams.get('scope');
      const baseScopes = clientScope
        ? clientScope.split(/\s+/).filter(Boolean)
        : resolveAuthScopes();
      const scopeSet = new Set([...baseScopes, 'User.Read', 'offline_access']);
      microsoftAuthUrl.searchParams.set('scope', Array.from(scopeSet).join(' '));

      res.redirect(microsoftAuthUrl.toString());
    });

    app.post('/token', async (req, res) => {
      try {
        const body = req.body;
        if (!body) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Request body is required',
          });
          return;
        }
        if (!body.grant_type) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'grant_type parameter is required',
          });
          return;
        }

        if (body.grant_type !== 'authorization_code') {
          // Refresh is handled server-side; sessions don't expose a refresh_token to MCP clients.
          res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: `Grant type '${body.grant_type}' is not supported. The MCP client receives a long-lived session id; refresh is handled server-side.`,
          });
          return;
        }

        const tenantId = this.secrets.tenantId || 'common';
        const clientId = this.secrets.clientId;
        const clientSecret = this.secrets.clientSecret;

        // Two-leg PKCE: pick the server-side verifier matching the client's verifier.
        let serverCodeVerifier: string | undefined;
        if (body.code_verifier) {
          serverCodeVerifier = this.pkceStore.consumeForClientVerifier(
            body.code_verifier as string
          );
          if (serverCodeVerifier) {
            logger.info('Two-leg PKCE: matched client verifier, using server verifier');
          }
        }

        const tokens = await exchangeCodeForToken(
          body.code as string,
          body.redirect_uri as string,
          clientId,
          clientSecret,
          tenantId,
          serverCodeVerifier || (body.code_verifier as string | undefined)
        );

        const session = this.sessionManager.createSession({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          // exchangeCodeForToken's return type doesn't include id_token because the
          // upstream helper was scope-narrowed. Cast to read it.
          id_token: (tokens as unknown as { id_token?: string }).id_token,
          scope: tokens.scope,
        });

        // Hand the MCP client our opaque session id in place of the real access_token.
        // Long expires_in so the client doesn't try to refresh; we refresh against
        // Microsoft transparently on each MCP call when needed.
        res.json({
          access_token: session.sessionId,
          token_type: 'Bearer',
          expires_in: 60 * 60 * 24 * 30, // 30 days
          scope: tokens.scope,
        });
      } catch (error) {
        if (error instanceof OAuthUpstreamError) {
          logger.warn('Token endpoint: upstream OAuth error', {
            upstream_status: error.status,
            error: error.body.error,
            suberror: error.body.suberror,
          });
        } else {
          logger.error('Token endpoint error:', error);
        }
        const { status, body } = toOAuthErrorResponse(error);
        res.status(status).json(body);
      }
    });

    app.post('/revoke', async (req, res) => {
      const token = req.body?.token;
      if (typeof token !== 'string' || token === '') {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'token is required',
        });
        return;
      }
      // RFC 7009 says respond 200 regardless of whether the token existed.
      await this.sessionManager.revokeSession(token).catch((error) => {
        logger.warn(`Revocation error (ignored): ${(error as Error).message}`);
      });
      res.status(200).end();
    });

    const mcpAuth = sessionAuth(this.sessionManager);
    const mcpHandlerFactory =
      (passBody: boolean) =>
      async (req: AuthenticatedRequest, res: Response): Promise<void> => {
        const handler = async () => {
          const server = this.createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          res.on('close', () => {
            transport.close();
            server.close();
          });

          await server.connect(transport);
          await transport.handleRequest(req as Request, res, passBody ? req.body : undefined);
        };

        try {
          const session = req.session;
          if (!session) {
            // sessionAuth guarantees session is set; defensive.
            res.status(500).json({ error: 'server_error' });
            return;
          }
          await requestContext.run(
            {
              accessToken: session.tokens.access_token,
              userOid: session.userOid,
              tenantId: session.tenantId,
              userPrincipalName: session.userPrincipalName,
            },
            handler
          );
        } catch (error) {
          logger.error('Error handling MCP request:', error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            });
          }
        }
      };

    app.get('/mcp', mcpAuth, mcpHandlerFactory(false));
    app.post('/mcp', mcpAuth, mcpHandlerFactory(true));

    app.get('/', (_req, res) => {
      res.send('Areté Microsoft 365 MCP Server is running');
    });

    if (host) {
      app.listen(port, host, () => {
        logger.info(`Server listening on ${host}:${port}`);
        logger.info(`  - MCP endpoint: http://${host}:${port}/mcp`);
        logger.info(
          `  - OAuth discovery: http://${host}:${port}/.well-known/oauth-authorization-server`
        );
      });
    } else {
      app.listen(port, () => {
        logger.info(`Server listening on all interfaces (0.0.0.0:${port})`);
        logger.info(`  - MCP endpoint: http://localhost:${port}/mcp`);
        logger.info(
          `  - OAuth discovery: http://localhost:${port}/.well-known/oauth-authorization-server`
        );
      });
    }
  }
}

export default MicrosoftGraphServer;
