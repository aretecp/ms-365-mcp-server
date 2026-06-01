/**
 * Static, deployment-time progressive disclosure.
 *
 * A small curated CORE set (the reads agents need constantly) always registers.
 * The rest of each domain is gated behind enabling that domain's toolset via the
 * `MS365_MCP_TOOLSETS` env var (comma-separated domains, or `all`). Unset = core
 * only — the smallest schema-token footprint.
 *
 * This is a tool-SURFACE control, not an OAuth-scope control: `resolveAuthScopes`
 * still unions scopes over every tool. Reducing the requested scope set for a
 * core deployment is a separate change (make `resolveAuthScopes` toolset-aware
 * AND register the Entra app with only the core scopes).
 */
import type { Toolset } from './tools/types.js';

export const ALL_TOOLSETS: readonly Toolset[] = [
  'mail',
  'calendar',
  'files',
  'directory',
  'teams',
  'sharepoint',
];

/**
 * Always-on core: the cross-domain reads an agent needs in nearly every session.
 * Utility tools (download-bytes, parse-teams-url) register unconditionally and
 * are not listed here.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'identity-get-me',
  'user-search',
  'user-get',
  'mail-folder-list',
  'mail-message-list',
  'mail-message-get',
  'calendar-view',
  'calendar-event-get',
  'drive-children-list',
  'drive-item-get',
]);

/** Enabled toolsets: `'all'` registers everything; a Set lists the enabled domains (core always on). */
export type ToolsetSelection = 'all' | ReadonlySet<string>;

/**
 * Resolve the enabled selection. An explicit value (from a caller/test) wins;
 * otherwise read `MS365_MCP_TOOLSETS`. Unset/empty = core only.
 */
export function resolveEnabledToolsets(explicit?: ToolsetSelection): ToolsetSelection {
  if (explicit !== undefined) return explicit;
  const raw = process.env.MS365_MCP_TOOLSETS?.trim();
  if (raw === undefined || raw === '') return new Set();
  if (raw.toLowerCase() === 'all') return 'all';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Whether a tool should register given the enabled selection. Core tools always register. */
export function isToolEnabled(
  tool: { name: string; toolset?: Toolset },
  enabled: ToolsetSelection
): boolean {
  if (enabled === 'all') return true;
  if (CORE_TOOL_NAMES.has(tool.name)) return true;
  return tool.toolset !== undefined && enabled.has(tool.toolset);
}

/** Whether a whole domain toolset is enabled (used to scope server instructions). */
export function isToolsetEnabled(toolset: Toolset, enabled: ToolsetSelection): boolean {
  return enabled === 'all' || enabled.has(toolset);
}
