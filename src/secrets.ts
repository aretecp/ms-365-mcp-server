import { getDefaultClientId } from './cloud-config.js';

export interface AppSecrets {
  clientId: string;
  tenantId: string;
  clientSecret?: string;
}

let cachedSecrets: AppSecrets | null = null;

export async function getSecrets(): Promise<AppSecrets> {
  if (cachedSecrets) {
    return cachedSecrets;
  }

  // Accept both our own MS365_MCP_* names and the MICROSOFT_* names Infisical
  // stores at /m365-mcp/ (pushed by the Entra terraform module). This lets
  // `infisical run --env <env> --path /m365-mcp -- ...` work locally without a
  // rename step, while production (docker-compose maps MICROSOFT_* ->
  // MS365_MCP_*) keeps working unchanged. MS365_MCP_* wins if both are set.
  cachedSecrets = {
    clientId:
      process.env.MS365_MCP_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || getDefaultClientId(),
    tenantId: process.env.MS365_MCP_TENANT_ID || process.env.MICROSOFT_TENANT_ID || 'common',
    clientSecret: process.env.MS365_MCP_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET,
  };
  return cachedSecrets;
}

export function clearSecretsCache(): void {
  cachedSecrets = null;
}
