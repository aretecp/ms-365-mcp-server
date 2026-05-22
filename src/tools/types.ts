import { z } from 'zod';

/**
 * Where a {@link ToolParam} value goes in the outbound Graph request.
 */
export type ParamLocation = 'path' | 'query' | 'header' | 'body';

/**
 * One parameter on a hand-written {@link Tool}. The Zod schema carries the
 * LLM-facing description (`schema.describe(...)`) and its required-ness
 * (`.optional()` for optional params).
 *
 * For body params, the convention is a single param named `body` whose schema
 * describes the request payload shape.
 */
export interface ToolParam {
  /**
   * Parameter name as the LLM sees it. For path params this must match the
   * placeholder in {@link Tool.path} (e.g. `message-id` to match `{message-id}`).
   * OData query params are exposed without the leading `$` (many MCP clients
   * cannot send `$` in identifier names); the runtime restores it for the
   * Graph URL.
   */
  name: string;
  location: ParamLocation;
  schema: z.ZodTypeAny;
}

/**
 * Tool definition consumed by the runtime in `tool-runtime.ts`. Areté
 * hand-writes one of these per Graph endpoint we expose; the upstream
 * generator-driven approach is gone in this rewrite.
 */
export interface Tool {
  /** MCP tool name (kebab-case, stable identifier). */
  name: string;
  /** LLM-facing description. Keep concise; put long guidance in `llmTip`. */
  description: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /**
   * Graph path with `{param-name}` placeholders. Resolved at request time
   * against the path params from {@link Tool.params}.
   */
  path: string;
  /**
   * Delegated Graph scopes required by this tool. Aggregated across the
   * tool surface to build the OAuth `scopes_supported` set.
   */
  scopes: string[];
  params: ToolParam[];
  /**
   * Optional longer guidance appended to the tool description as
   * `\n\n💡 TIP: <llmTip>`. Use for KQL syntax, $select recommendations,
   * etc. — anything that helps the model use the tool correctly.
   */
  llmTip?: string;
  /** Calendar tools: adds the `timezone` MCP param mapping to Prefer header. */
  supportsTimezone?: boolean;
  /** Calendar tools: adds the `expandExtendedProperties` MCP param. */
  supportsExpandExtendedProperties?: boolean;
  /** Drive-content tools: strip `/content` suffix and return Graph's pre-redirect URL instead of the bytes. */
  returnDownloadUrl?: boolean;
  /** Override the default `application/json` content type for write endpoints. */
  contentType?: string;
  /** Override the default Accept header for non-JSON response endpoints. */
  acceptType?: string;
  /** Names of path params whose values must NOT be URL-encoded (function-style API calls). */
  skipEncoding?: string[];
  /**
   * Marks a POST endpoint as logically read-only (e.g. `find-meeting-times`).
   * Reserved for a future read-only-mode toggle; ignored by the v1 runtime.
   */
  readOnly?: boolean;
}

/**
 * Standard OData $-prefixed query parameters reused across Graph tools.
 * Each Tool that supports paging/filtering opts in by spreading the relevant
 * entries into its `params` array. Descriptions match the spec-gap guidance
 * carried over from the upstream graph-tools schema overrides.
 */
export const OData = {
  filter: {
    name: 'filter',
    location: 'query',
    schema: z
      .string()
      .describe(
        'OData $filter expression. Add count=true for advanced filters (flag/flagStatus, contains()). Cannot combine with search.'
      )
      .optional(),
  },
  search: {
    name: 'search',
    location: 'query',
    schema: z
      .string()
      .describe('KQL $search query — wrap value in double quotes. Cannot combine with filter.')
      .optional(),
  },
  select: {
    name: 'select',
    location: 'query',
    schema: z
      .string()
      .describe('Comma-separated fields to return ($select), e.g. id,subject,from,receivedDateTime')
      .optional(),
  },
  orderby: {
    name: 'orderby',
    location: 'query',
    schema: z.string().describe('$orderby sort expression, e.g. receivedDateTime desc').optional(),
  },
  top: {
    name: 'top',
    location: 'query',
    schema: z
      .number()
      .describe(
        'Page size ($top). Start small (e.g. 5–15) so responses fit the model context; ' +
          'raise only if needed. Use select to return fewer fields per item. ' +
          'For more rows, use @odata.nextLink from the response instead of a very large top.'
      )
      .optional(),
  },
  skip: {
    name: 'skip',
    location: 'query',
    schema: z
      .number()
      .describe('Items to $skip for pagination. Not supported with search.')
      .optional(),
  },
  count: {
    name: 'count',
    location: 'query',
    schema: z
      .boolean()
      .describe(
        'Set true to enable advanced query mode (ConsistencyLevel: eventual). Required for complex $filter on flag/flagStatus or contains().'
      )
      .optional(),
  },
  expand: {
    name: 'expand',
    location: 'query',
    schema: z
      .string()
      .describe(
        'Comma-separated $expand navigation properties to expand inline, e.g. attachments,extensions'
      )
      .optional(),
  },
} as const satisfies Record<string, ToolParam>;

/** Set of OData query param base names (without `$`). The runtime prepends `$` when building the Graph URL. */
export const ODATA_PARAM_NAMES = new Set([
  'filter',
  'search',
  'select',
  'orderby',
  'skip',
  'top',
  'count',
  'expand',
  'format',
]);
