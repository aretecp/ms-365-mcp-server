import type { Tool } from './types.js';
import { mailTools } from './mail.js';
import { calendarTools } from './calendar.js';
import { filesTools } from './files.js';
import { identityTools } from './identity.js';

export type { Tool, ToolParam, ParamLocation } from './types.js';
export { OData, ODATA_PARAM_NAMES } from './types.js';
export {
  utilityTools,
  type UtilityTool,
  type UtilityToolContext,
  type CallToolResult,
} from './utility.js';

/**
 * Every Graph-backed tool exposed by the v1 server. Utility tools (download-bytes,
 * parse-teams-url) are registered separately because they have a different
 * runtime shape — see {@link utilityTools}.
 */
export const ALL_TOOLS: readonly Tool[] = [
  ...mailTools,
  ...calendarTools,
  ...filesTools,
  ...identityTools,
];
