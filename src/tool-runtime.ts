import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import logger from './logger.js';
import GraphClient from './graph-client.js';
import { getRequestContext } from './request-context.js';
import type { PolicyChecker } from './policy/index.js';
import {
  ALL_TOOLS,
  ODATA_PARAM_NAMES,
  utilityTools,
  type Tool,
  type ToolParam,
  type UtilityTool,
  type UtilityToolContext,
  type CallToolResult,
} from './tools/index.js';
import { toolCallLog, redactArgs, redactResponse } from './admin/tool-call-log.js';
import { MINIMAL_SELECT } from './tools/projections.js';
import {
  resolveEnabledToolsets,
  isToolEnabled,
  type ToolsetSelection,
} from './toolset-config.js';

/** Hard cap on Graph `$top` for list requests, configurable via env. */
function maxTopFromEnv(): number | undefined {
  const raw = process.env.MS365_MCP_MAX_TOP;
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    logger.warn(
      `Ignoring invalid MS365_MCP_MAX_TOP=${JSON.stringify(raw)} (use a positive integer)`
    );
    return undefined;
  }
  return n;
}

function clampTopQueryParam(queryParams: Record<string, string>): void {
  const cap = maxTopFromEnv();
  if (cap === undefined || queryParams['$top'] === undefined) return;
  const requested = Number.parseInt(queryParams['$top'], 10);
  if (!Number.isFinite(requested) || requested <= cap) return;
  logger.info(`Clamping $top from ${requested} to ${cap} (MS365_MCP_MAX_TOP)`);
  queryParams['$top'] = String(cap);
}

/** Positive-integer env override with a fallback, shared by the default-$top and response-ceiling knobs. */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    logger.warn(`Ignoring invalid ${name}=${JSON.stringify(raw)} (use a positive integer)`);
    return fallback;
  }
  return n;
}

/** Default page size injected for list GETs when the caller omits `$top`. */
function defaultTop(): number {
  return positiveIntFromEnv('MS365_MCP_DEFAULT_TOP', 15);
}

/**
 * Hard char ceiling for a single tool response. ~4 chars/token, so the default
 * ~100k chars approximates Claude Code's ~25k-token tool-response cap. A list
 * response over the ceiling is truncated at an element boundary and wrapped in
 * a marked envelope (see {@link shapeResponseSize}).
 */
function maxResponseChars(): number {
  return positiveIntFromEnv('MS365_MCP_MAX_RESPONSE_CHARS', 100_000);
}

/** A list tool exposes the OData `top` param; by-id reads do not. Used to gate default `$top`. */
function isListTool(tool: Tool): boolean {
  return tool.method === 'GET' && tool.params.some((p) => p.name === 'top');
}

/**
 * Enforce the response-size ceiling on a JSON list payload. Only collections
 * (`{ value: [...] }`) are reshaped — non-collection and non-JSON (binary)
 * responses are returned untouched. When over budget, items are dropped from
 * the end (halving) until the serialized envelope fits, and the result is
 * wrapped as `{ value, truncated, returnedCount, totalCount, hint }` — keeping
 * the Graph `value` key so callers/`fetchAllPages` shapes still match.
 *
 * The hint steers the model to NARROW the request (filter/search/top/select or a
 * tighter scope) rather than paginate: there is deliberately no continuation
 * cursor. No tool consumes one, and after a `fetchAllPages` merge the
 * `@odata.nextLink` is already gone — and even when present it points *past* the
 * dropped tail, so a cursor would skip the very items that were truncated.
 * Narrowing is the only correct continuation.
 *
 * Note: this runs on the already-serialized JSON text, mirroring the
 * `fetchAllPages` merge which also assumes JSON. In TOON output mode the text
 * is not JSON, so it is returned untouched — default `$top` + projection bound
 * those payloads instead.
 */
function shapeResponseSize(text: string): string {
  const cap = maxResponseChars();
  if (text.length <= cap) return text;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const items = parsed['value'];
  if (!Array.isArray(items)) return text;

  let kept = items.length;
  let envelope: Record<string, unknown> = parsed;
  while (kept > 0) {
    envelope = {
      value: items.slice(0, kept),
      truncated: true,
      returnedCount: kept,
      totalCount: items.length,
      hint:
        `Response truncated to ${kept} of ${items.length} items to fit the context budget. ` +
        'Narrow the request ($filter/$search/$top/$select, or a tighter date/folder scope) to see the rest — there is no continuation cursor.',
    };
    const size = JSON.stringify(envelope).length;
    if (size <= cap || kept === 1) {
      if (kept === 1 && size > cap) {
        logger.warn(
          `Single item still exceeds the response-size ceiling (${size} > ${cap} chars); returning it anyway.`
        );
      }
      break;
    }
    kept = Math.floor(kept / 2);
  }
  logger.info(`Truncated list response from ${items.length} to ${kept} items (response-size ceiling)`);
  return JSON.stringify(envelope);
}

/**
 * Inject the default field projection and page size for read tools when the
 * caller omitted them. Projection is skipped when `response_format: 'detailed'`.
 */
function applyResponseDefaults(
  tool: Tool,
  queryParams: Record<string, string>,
  params: Record<string, unknown>
): void {
  const wantsDetailed = params.response_format === 'detailed';
  if (
    tool.projection &&
    tool.method === 'GET' &&
    !wantsDetailed &&
    queryParams['$select'] === undefined
  ) {
    queryParams['$select'] = MINIMAL_SELECT[tool.projection];
  }
  if (isListTool(tool) && queryParams['$top'] === undefined && params.fetchAllPages !== true) {
    queryParams['$top'] = String(defaultTop());
  }
}

/** Returns the Graph URL form (`$top`, `$filter`, ...) of an OData query param name. */
function odataQueryKey(rawName: string): string {
  const lower = rawName.toLowerCase();
  return ODATA_PARAM_NAMES.has(lower) ? `$${lower}` : rawName;
}

/** Encode a path-param value while preserving `=` (Graph IDs are base64-ish). */
function encodePathValue(value: string): string {
  return encodeURIComponent(value).replace(/%3D/g, '=');
}

const CONTROL_PARAM_NAMES = new Set([
  'fetchAllPages',
  'includeHeaders',
  'excludeResponse',
  'timezone',
  'expandExtendedProperties',
  'response_format',
]);

function policyDeniedResult(tool: Tool, upn: string | null): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: `Policy denied tool '${tool.name}' for user '${upn ?? 'unknown'}'.`,
          tip: 'Update policy.yaml or contact the operator to enable this tool for this user.',
        }),
      },
    ],
    isError: true,
  };
}

function preconditionFailedResult(tool: Tool, message: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: `Server-side precondition failed for tool '${tool.name}': ${message}`,
          tip: 'This invariant is enforced in the MCP server runtime, not by tool description or policy. Adjust the tool call to satisfy it.',
        }),
      },
    ],
    isError: true,
  };
}

async function executeTool(
  tool: Tool,
  graphClient: GraphClient,
  params: Record<string, unknown>,
  policy?: PolicyChecker
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const ctx = getRequestContext();
  const upn = ctx?.userPrincipalName ?? null;
  logger.info(`Tool ${tool.name} called with params: ${JSON.stringify(params)}`);

  if (policy && !policy.check({ userPrincipalName: upn, toolName: tool.name })) {
    logger.warn(
      `Policy denied tool ${tool.name} for ${upn ?? 'anonymous'} (oid=${ctx?.userOid ?? 'n/a'})`
    );
    toolCallLog.record({
      id: crypto.randomUUID(),
      ts: startedAt,
      upn,
      toolName: tool.name,
      status: 'denied_by_policy',
      latencyMs: Date.now() - startedAt,
      argsExcerpt: redactArgs(params),
      responseExcerpt: null,
      errorText: `Policy denied tool '${tool.name}' for user '${upn ?? 'unknown'}'.`,
    });
    return policyDeniedResult(tool, upn);
  }

  // Server-side guards run AFTER policy and BEFORE any outbound Graph call.
  // Throw from the precondition to refuse — tool descriptions are not
  // load-bearing for security; the runtime enforces invariants in code.
  if (tool.precondition) {
    try {
      await tool.precondition(graphClient, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Precondition refused tool ${tool.name} for ${upn ?? 'anonymous'}: ${message}`);
      toolCallLog.record({
        id: crypto.randomUUID(),
        ts: startedAt,
        upn,
        toolName: tool.name,
        status: 'precondition_failed',
        latencyMs: Date.now() - startedAt,
        argsExcerpt: redactArgs(params),
        responseExcerpt: null,
        errorText: message,
      });
      return preconditionFailedResult(tool, message);
    }
  }

  try {
    const paramByName = new Map<string, ToolParam>();
    for (const p of tool.params) paramByName.set(p.name, p);

    let path = tool.pathResolver ? tool.pathResolver(params) : tool.path;
    const queryParams: Record<string, string> = {};
    const headers: Record<string, string> = {};
    let body: unknown = null;

    // Apply the tool's hard-coded request headers first; any header passed
    // through a ToolParam (location: 'header') in the params loop below will
    // override these by overwriting the same key.
    if (tool.requestHeaders) {
      for (const [k, v] of Object.entries(tool.requestHeaders)) headers[k] = v;
    }

    for (const [paramName, paramValue] of Object.entries(params)) {
      if (CONTROL_PARAM_NAMES.has(paramName)) continue;
      // Params consumed by a pathResolver are already baked into the path —
      // skip them so they don't leak to the query string or the unknown-param
      // path-placeholder fallback below.
      if (tool.resolverParams?.includes(paramName)) continue;

      const def = paramByName.get(paramName);

      if (!def) {
        if (path.includes(`{${paramName}}`)) {
          path = path.replace(`{${paramName}}`, encodePathValue(String(paramValue)));
          logger.info(`Unknown param ${paramName} matched path placeholder; substituted anyway`);
        }
        continue;
      }

      switch (def.location) {
        case 'path': {
          const shouldSkip = tool.skipEncoding?.includes(paramName) ?? false;
          const encoded = shouldSkip ? String(paramValue) : encodePathValue(String(paramValue));
          path = path.replace(`{${paramName}}`, encoded);
          break;
        }
        case 'query': {
          if (paramValue === '' || paramValue == null) break;
          queryParams[odataQueryKey(paramName)] = String(paramValue);
          break;
        }
        case 'header': {
          headers[paramName] = String(paramValue);
          break;
        }
        case 'body': {
          body = paramValue;
          break;
        }
      }
    }

    // Invariant: every `{placeholder}` must have been substituted (by the param
    // loop or by a pathResolver). A leftover means a malformed resolver or a
    // missing path param — the Graph call would fail; surface it loudly.
    const unresolved = path.match(/\{[^}]+\}/);
    if (unresolved) {
      logger.warn(
        `Tool ${tool.name} left an unsubstituted path placeholder ${unresolved[0]} — the Graph call will likely fail.`
      );
    }

    applyResponseDefaults(tool, queryParams, params);
    clampTopQueryParam(queryParams);

    const preferValues: string[] = [];

    if (tool.supportsTimezone && typeof params.timezone === 'string' && params.timezone !== '') {
      preferValues.push(`outlook.timezone="${params.timezone}"`);
    }

    const bodyFormat = process.env.MS365_MCP_BODY_FORMAT || 'text';
    if (bodyFormat !== 'html' && tool.method === 'GET') {
      preferValues.push(`outlook.body-content-type="${bodyFormat}"`);
    }

    if (preferValues.length > 0) {
      headers['Prefer'] = preferValues.join(', ');
    }

    if (tool.supportsExpandExtendedProperties && params.expandExtendedProperties === true) {
      const expandValue = 'singleValueExtendedProperties';
      queryParams['$expand'] = queryParams['$expand']
        ? `${queryParams['$expand']},${expandValue}`
        : expandValue;
    }

    if (tool.contentType) {
      headers['Content-Type'] = tool.contentType;
    }
    if (tool.acceptType) {
      headers['Accept'] = tool.acceptType;
    }

    if (Object.keys(queryParams).length > 0) {
      const queryString = Object.entries(queryParams)
        .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%2C/gi, ',')}`)
        .join('&');
      path = `${path}${path.includes('?') ? '&' : '?'}${queryString}`;
    }

    const requestOptions: {
      method: string;
      headers: Record<string, string>;
      body?: string | Buffer | Uint8Array;
      rawResponse?: boolean;
      includeHeaders?: boolean;
      excludeResponse?: boolean;
    } = {
      method: tool.method,
      headers,
    };

    if (tool.method !== 'GET' && body) {
      if (tool.contentType === 'text/html') {
        if (typeof body === 'string') {
          requestOptions.body = body;
        } else if (typeof body === 'object' && body !== null && 'content' in body) {
          requestOptions.body = (body as { content: string }).content;
        } else {
          requestOptions.body = String(body);
        }
      } else {
        requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }

    if (tool.returnDownloadUrl && path.endsWith('/content')) {
      path = path.replace(/\/content$/, '');
    } else if (path.includes('/content') || path.endsWith('/$value')) {
      requestOptions.rawResponse = true;
    }

    if (params.includeHeaders === true) requestOptions.includeHeaders = true;
    if (params.excludeResponse === true) requestOptions.excludeResponse = true;

    logger.info(`Making graph request to ${path} with options: ${JSON.stringify(requestOptions)}`);

    const response = await graphClient.graphRequest(path, requestOptions);

    const fetchAllPages = params.fetchAllPages === true;
    if (fetchAllPages && response?.content?.[0]?.text) {
      // The page merge below parses and re-serializes JSON. In TOON output mode
      // the response text is not JSON, so merging is impossible — refuse rather
      // than silently return only the first page (a data-completeness failure
      // that would let the model believe it has the full result set). See #19.
      if (graphClient.format === 'toon') {
        logger.error(`fetchAllPages requested in TOON output mode for ${tool.name}; refusing`);
        response.content[0].text = JSON.stringify({
          error:
            'fetchAllPages is not supported in TOON output mode: pages cannot be merged. ' +
            'Re-run the server in JSON output format (omit --toon / unset MS365_MCP_OUTPUT_FORMAT) ' +
            'to use fetchAllPages, or narrow the request with filter/search/top.',
        });
        response.isError = true;
      } else {
        try {
          const combined = JSON.parse(response.content[0].text);
          let allItems = combined.value || [];
          let nextLink = combined['@odata.nextLink'];
          let pageCount = 1;
          const maxPages = 100;
          const maxItems = 10_000;

          while (nextLink && pageCount < maxPages && allItems.length < maxItems) {
            logger.info(`Fetching page ${pageCount + 1} from: ${nextLink}`);
            const url = new URL(nextLink);
            const nextPath = url.pathname.replace('/v1.0', '') + url.search;
            const nextResponse = await graphClient.graphRequest(nextPath, { ...requestOptions });
            if (nextResponse?.content?.[0]?.text) {
              const next = JSON.parse(nextResponse.content[0].text);
              if (Array.isArray(next.value)) allItems = allItems.concat(next.value);
              nextLink = next['@odata.nextLink'];
              pageCount++;
            } else {
              break;
            }
          }

          if (pageCount >= maxPages) {
            logger.warn(`Reached maximum page limit (${maxPages}) for pagination`);
          }
          if (allItems.length >= maxItems) {
            logger.warn(
              `Reached maximum item limit (${maxItems}) for pagination — truncated at ${allItems.length} items`
            );
          }

          combined.value = allItems;
          if (combined['@odata.count']) combined['@odata.count'] = allItems.length;
          delete combined['@odata.nextLink'];

          response.content[0].text = JSON.stringify(combined);
          logger.info(
            `Pagination complete: collected ${allItems.length} items across ${pageCount} pages`
          );
        } catch (e) {
          // A parse/merge failure here means we cannot guarantee a complete
          // result set. Surface it as an error rather than falling through and
          // returning the (possibly partial) first page as a silent success. See #19.
          logger.error(`Error during pagination: ${e}`);
          response.content[0].text = JSON.stringify({
            error:
              `fetchAllPages failed to merge all pages for ${tool.name}: ${e}. ` +
              'The result is incomplete; do not treat it as the full set. ' +
              'Retry, or narrow the request with filter/search/top.',
          });
          response.isError = true;
        }
      }
    }

    // Enforce the response-size ceiling on JSON list payloads (binary/download
    // responses use rawResponse and are exempt). Runs after the fetchAllPages
    // merge so it bounds the merged result too.
    if (!requestOptions.rawResponse && response?.content?.[0]?.text) {
      response.content[0].text = shapeResponseSize(response.content[0].text);
    }

    const result: CallToolResult = {
      content: response.content.map((item) => ({ type: 'text' as const, text: item.text })),
      _meta: response._meta,
      isError: response.isError,
    };
    const responseText = response.content[0]?.text ?? null;
    if (result.isError) {
      toolCallLog.record({
        id: crypto.randomUUID(),
        ts: startedAt,
        upn,
        toolName: tool.name,
        status: 'graph_error',
        latencyMs: Date.now() - startedAt,
        argsExcerpt: redactArgs(params),
        responseExcerpt: null,
        errorText: redactResponse(responseText),
      });
    } else {
      toolCallLog.record({
        id: crypto.randomUUID(),
        ts: startedAt,
        upn,
        toolName: tool.name,
        status: 'allowed',
        latencyMs: Date.now() - startedAt,
        argsExcerpt: redactArgs(params),
        responseExcerpt: redactResponse(responseText),
        errorText: null,
      });
    }
    return result;
  } catch (error) {
    const message = (error as Error).message;
    logger.error(`Error in tool ${tool.name}: ${message}`);
    toolCallLog.record({
      id: crypto.randomUUID(),
      ts: startedAt,
      upn,
      toolName: tool.name,
      status: 'graph_error',
      latencyMs: Date.now() - startedAt,
      argsExcerpt: redactArgs(params),
      responseExcerpt: null,
      errorText: redactResponse(message),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Error in tool ${tool.name}: ${message}`,
          }),
        },
      ],
      isError: true,
    };
  }
}

function buildMcpParamSchema(tool: Tool): Record<string, z.ZodTypeAny> {
  const paramSchema: Record<string, z.ZodTypeAny> = {};
  for (const p of tool.params) paramSchema[p.name] = p.schema;

  if (tool.method === 'GET') {
    paramSchema['fetchAllPages'] = z
      .boolean()
      .describe(
        'Follow @odata.nextLink and merge up to 100 pages into one response. ' +
          'Can return enormous payloads — only when the user explicitly needs a full export. ' +
          'Prefer a small top first, then paginate or narrow with filter/search.'
      )
      .optional();
  }

  if (tool.projection) {
    paramSchema['response_format'] = z
      .enum(['minimal', 'detailed'])
      .describe(
        "Field detail. 'minimal' (default) returns a compact, high-signal field set; " +
          "'detailed' returns the full Graph object (more tokens, raw ids). Omit for minimal. " +
          'Not a confidentiality boundary — any caller allowed on this tool may request detailed.'
      )
      .optional();
  }

  paramSchema['includeHeaders'] = z
    .boolean()
    .describe('Include response headers (including ETag) in the response metadata')
    .optional();

  paramSchema['excludeResponse'] = z
    .boolean()
    .describe('Exclude the full response body and only return success or failure indication')
    .optional();

  if (tool.supportsTimezone) {
    paramSchema['timezone'] = z
      .string()
      .describe(
        'IANA timezone name (e.g., "America/New_York", "Europe/London", "Asia/Tokyo") for calendar event times. If not specified, times are returned in UTC.'
      )
      .optional();
  }

  if (tool.supportsExpandExtendedProperties) {
    paramSchema['expandExtendedProperties'] = z
      .boolean()
      .describe(
        'When true, expands singleValueExtendedProperties on each event. Use this to retrieve custom extended properties (e.g., sync metadata) stored on calendar events.'
      )
      .optional();
  }

  return paramSchema;
}

function registerUtilityToolWithMcp(
  server: McpServer,
  utility: UtilityTool,
  ctx: UtilityToolContext,
  policy?: PolicyChecker
): void {
  server.tool(
    utility.name,
    utility.description,
    utility.buildSchema(ctx),
    {
      title: utility.name,
      readOnlyHint: utility.readOnlyHint ?? true,
      openWorldHint: utility.openWorldHint ?? true,
    },
    async (params) => {
      const utilStartedAt = Date.now();
      const reqCtx = getRequestContext();
      const utilUpn = reqCtx?.userPrincipalName ?? null;

      if (policy) {
        if (
          !policy.check({
            userPrincipalName: utilUpn,
            toolName: utility.name,
          })
        ) {
          toolCallLog.record({
            id: crypto.randomUUID(),
            ts: utilStartedAt,
            upn: utilUpn,
            toolName: utility.name,
            status: 'denied_by_policy',
            latencyMs: Date.now() - utilStartedAt,
            argsExcerpt: redactArgs(params),
            responseExcerpt: null,
            errorText: `Policy denied tool '${utility.name}' for user '${utilUpn ?? 'unknown'}'.`,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Policy denied tool '${utility.name}' for user '${utilUpn ?? 'unknown'}'.`,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      try {
        const utilResult = await utility.execute(params, ctx);
        const utilText =
          (utilResult as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? null;
        const isErr = (utilResult as { isError?: boolean }).isError === true;
        toolCallLog.record({
          id: crypto.randomUUID(),
          ts: utilStartedAt,
          upn: utilUpn,
          toolName: utility.name,
          status: isErr ? 'graph_error' : 'allowed',
          latencyMs: Date.now() - utilStartedAt,
          argsExcerpt: redactArgs(params),
          responseExcerpt: isErr ? null : redactResponse(utilText),
          errorText: isErr ? redactResponse(utilText) : null,
        });
        return utilResult;
      } catch (utilErr) {
        const utilMsg = (utilErr as Error).message;
        toolCallLog.record({
          id: crypto.randomUUID(),
          ts: utilStartedAt,
          upn: utilUpn,
          toolName: utility.name,
          status: 'graph_error',
          latencyMs: Date.now() - utilStartedAt,
          argsExcerpt: redactArgs(params),
          responseExcerpt: null,
          errorText: redactResponse(utilMsg),
        });
        throw utilErr;
      }
    }
  );
}

export interface RegisterToolsOptions {
  policy?: PolicyChecker;
  /**
   * Which toolsets to register. Defaults to the `MS365_MCP_TOOLSETS` env value
   * (unset = core only). Pass `'all'` to register everything (used by tests).
   */
  toolsets?: ToolsetSelection;
}

/**
 * Surface drift between the policy file and the registered tool set so operators
 * can reconcile the two control planes:
 *   - WARN: a policy allow/deny entry naming a tool that is not registered
 *     (toolset disabled or stale name) — calls would be denied as unknown.
 *   - INFO: how many registered tools are absent from defaults.allow (they fail
 *     closed until added to a per-user allow block — expected for write tools).
 */
function logPolicyRegistrationDrift(
  policy: PolicyChecker | undefined,
  registeredNames: Set<string>
): void {
  if (!policy?.summary) return;
  const summary = policy.summary();
  const policyNames = new Set<string>([
    ...summary.defaultAllow,
    ...summary.users.flatMap((u) => [...u.allow, ...u.deny]),
  ]);
  for (const name of policyNames) {
    if (!registeredNames.has(name)) {
      logger.warn(
        `Policy references tool '${name}' which is not registered (toolset disabled or renamed) — calls would be denied as unknown.`
      );
    }
  }
  const defaultAllow = new Set(summary.defaultAllow);
  const notInDefaults = [...registeredNames].filter((n) => !defaultAllow.has(n));
  if (notInDefaults.length > 0) {
    logger.info(
      `${notInDefaults.length} registered tool(s) are not in defaults.allow and will be denied until added to a policy allow block.`
    );
  }
}

export function registerTools(
  server: McpServer,
  graphClient: GraphClient,
  options: RegisterToolsOptions = {}
): number {
  let registeredCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const enabled = resolveEnabledToolsets(options.toolsets);
  const registeredNames = new Set<string>();

  for (const tool of ALL_TOOLS) {
    if (!isToolEnabled(tool, enabled)) {
      skippedCount++;
      continue;
    }
    const description = tool.llmTip
      ? `${tool.description}\n\n💡 TIP: ${tool.llmTip}`
      : tool.description;

    try {
      server.tool(
        tool.name,
        description,
        buildMcpParamSchema(tool),
        {
          title: tool.name,
          readOnlyHint: tool.method === 'GET',
          destructiveHint: ['POST', 'PATCH', 'DELETE'].includes(tool.method),
          openWorldHint: true,
        },
        async (params) => executeTool(tool, graphClient, params, options.policy)
      );
      registeredCount++;
      registeredNames.add(tool.name);
    } catch (error) {
      logger.error(`Failed to register tool ${tool.name}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  // Utility tools always register (core utilities, no toolset gating).
  const utilityCtx: UtilityToolContext = { graphClient };
  for (const utility of utilityTools) {
    try {
      registerUtilityToolWithMcp(server, utility, utilityCtx, options.policy);
      registeredCount++;
      registeredNames.add(utility.name);
    } catch (error) {
      logger.error(`Failed to register tool ${utility.name}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  logPolicyRegistrationDrift(options.policy, registeredNames);
  logger.info(
    `Tool registration complete: ${registeredCount} registered, ${skippedCount} skipped (toolset disabled), ${failedCount} failed`
  );
  return registeredCount;
}

/** Test seam: lets tests invoke the runtime against a Tool definition without the McpServer registration path. */
export { executeTool };
