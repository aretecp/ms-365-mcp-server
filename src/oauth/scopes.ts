import { ALL_TOOLS } from '../tools/index.js';

/**
 * Union of all delegated Graph scopes required by the registered Tool surface.
 * Used to advertise `scopes_supported` in OAuth metadata and to request the
 * right consent set at /authorize. `offline_access` is added by /authorize so
 * Entra issues a refresh token; not advertised in scopes_supported because
 * advertising it can cause MCP clients to surface a separate consent prompt.
 */
export function resolveAuthScopes(): string[] {
  const scopes = new Set<string>();
  for (const tool of ALL_TOOLS) {
    for (const scope of tool.scopes) scopes.add(scope);
  }
  return Array.from(scopes);
}
