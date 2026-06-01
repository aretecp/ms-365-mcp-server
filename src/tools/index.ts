import type { Tool } from './types.js';
import { mailTools } from './mail.js';
import { calendarTools } from './calendar.js';
import { filesTools } from './files.js';
import { identityTools } from './identity.js';
import { teamsTools } from './teams.js';
import { usersTools } from './users.js';
import { sharepointTools } from './sharepoint.js';

export type { Tool, ToolParam, ParamLocation } from './types.js';
export { OData, ODATA_PARAM_NAMES } from './types.js';
export {
  utilityTools,
  type UtilityTool,
  type UtilityToolContext,
  type CallToolResult,
} from './utility.js';

import type { Toolset } from './types.js';

/** Stamp a domain toolset onto each tool (a tool may pre-set its own). */
function tagToolset(tools: readonly Tool[], toolset: Toolset): Tool[] {
  return tools.map((t) => (t.toolset ? t : { ...t, toolset }));
}

/**
 * Every Graph-backed tool exposed by the v1 server, tagged with a domain toolset
 * for static progressive disclosure (see `toolset-config.ts`). Utility tools
 * (download-bytes, parse-teams-url) are registered separately because they have
 * a different runtime shape — see {@link utilityTools}.
 */
export const ALL_TOOLS: readonly Tool[] = [
  ...tagToolset(mailTools, 'mail'),
  ...tagToolset(calendarTools, 'calendar'),
  ...tagToolset(filesTools, 'files'),
  ...tagToolset(identityTools, 'directory'),
  ...tagToolset(teamsTools, 'teams'),
  ...tagToolset(usersTools, 'directory'),
  ...tagToolset(sharepointTools, 'sharepoint'),
];
