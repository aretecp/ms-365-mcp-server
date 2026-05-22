import logger from '../logger.js';
import { getCloudEndpoints } from '../cloud-config.js';

export interface UpstreamOAuthErrorBody {
  error: string;
  error_description?: string;
  error_codes?: number[];
  suberror?: string;
  trace_id?: string;
  correlation_id?: string;
  timestamp?: string;
}

export class OAuthUpstreamError extends Error {
  readonly status: number;
  readonly body: UpstreamOAuthErrorBody;
  readonly raw: string;

  constructor(status: number, raw: string, body: UpstreamOAuthErrorBody) {
    const suffix = body.error_description ? ` - ${body.error_description}` : '';
    super(`OAuth upstream error: ${body.error}${suffix}`);
    this.name = 'OAuthUpstreamError';
    this.status = status;
    this.body = body;
    this.raw = raw;
  }
}

function parseUpstreamOAuthError(raw: string): UpstreamOAuthErrorBody | null {
  try {
    const json = JSON.parse(raw) as unknown;
    if (
      json !== null &&
      typeof json === 'object' &&
      typeof (json as { error?: unknown }).error === 'string'
    ) {
      return json as UpstreamOAuthErrorBody;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function toOAuthErrorResponse(error: unknown): {
  status: number;
  body: { error: string; error_description?: string; suberror?: string };
} {
  if (error instanceof OAuthUpstreamError) {
    const body: { error: string; error_description?: string; suberror?: string } = {
      error: error.body.error,
    };
    if (error.body.error_description) body.error_description = error.body.error_description;
    if (error.body.suberror) body.suberror = error.body.suberror;
    return { status: 400, body };
  }
  return {
    status: 500,
    body: {
      error: 'server_error',
      error_description: 'Internal server error during token exchange',
    },
  };
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string | undefined,
  tenantId: string = 'common',
  codeVerifier?: string
): Promise<{
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
}> {
  const cloudEndpoints = getCloudEndpoints();
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });

  // Add client_secret for confidential clients
  if (clientSecret) {
    params.append('client_secret', clientSecret);
  }

  // Add code_verifier for PKCE flow
  if (codeVerifier) {
    params.append('code_verifier', codeVerifier);
  }

  const response = await fetch(`${cloudEndpoints.authority}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const raw = await response.text();
    const parsed = parseUpstreamOAuthError(raw);
    if (parsed) {
      logger.warn(`Token endpoint upstream OAuth error: ${parsed.error}`, {
        status: response.status,
        error: parsed.error,
        suberror: parsed.suberror,
        error_codes: parsed.error_codes,
        correlation_id: parsed.correlation_id,
      });
      throw new OAuthUpstreamError(response.status, raw, parsed);
    }
    logger.error(`Failed to exchange code for token: ${raw}`);
    throw new Error(`Failed to exchange code for token: ${raw}`);
  }

  return response.json();
}

/**
 * Refresh an access token
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string | undefined,
  tenantId: string = 'common'
): Promise<{
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const cloudEndpoints = getCloudEndpoints();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  if (clientSecret) {
    params.append('client_secret', clientSecret);
  }

  const response = await fetch(`${cloudEndpoints.authority}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const raw = await response.text();
    const parsed = parseUpstreamOAuthError(raw);
    if (parsed) {
      logger.warn(`Token endpoint upstream OAuth error: ${parsed.error}`, {
        status: response.status,
        error: parsed.error,
        suberror: parsed.suberror,
        error_codes: parsed.error_codes,
        correlation_id: parsed.correlation_id,
      });
      throw new OAuthUpstreamError(response.status, raw, parsed);
    }
    logger.error(`Failed to refresh token: ${raw}`);
    throw new Error(`Failed to refresh token: ${raw}`);
  }

  return response.json();
}
