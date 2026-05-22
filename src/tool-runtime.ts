import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import logger from './logger.js';
import GraphClient from './graph-client.js';
import AuthManager from './auth.js';
import { getRequestTokens } from './request-context.js';
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
  'account',
  'fetchAllPages',
  'includeHeaders',
  'excludeResponse',
  'timezone',
  'expandExtendedProperties',
]);

async function executeTool(
  tool: Tool,
  graphClient: GraphClient,
  authManager: AuthManager | undefined,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  logger.info(`Tool ${tool.name} called with params: ${JSON.stringify(params)}`);
  try {
    // Resolve account-specific token for the local-MSAL path (multi-account).
    // Skip when an HTTP/OAuth bearer token is already in request context — that token wins.
    let accountAccessToken: string | undefined;
    if (authManager && !authManager.isOAuthModeEnabled() && !getRequestTokens()) {
      const accountParam = params.account as string | undefined;
      try {
        accountAccessToken = await authManager.getTokenForAccount(accountParam);
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    }

    const paramByName = new Map<string, ToolParam>();
    for (const p of tool.params) paramByName.set(p.name, p);

    let path = tool.path;
    const queryParams: Record<string, string> = {};
    const headers: Record<string, string> = {};
    let body: unknown = null;

    for (const [paramName, paramValue] of Object.entries(params)) {
      if (CONTROL_PARAM_NAMES.has(paramName)) continue;

      const def = paramByName.get(paramName);

      if (!def) {
        // Unknown param. Tolerate it only if it happens to match a path placeholder (defensive).
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
      accessToken?: string;
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

    // Drive-content endpoints either return the bytes directly (raw) or a 302
    // download URL when returnDownloadUrl is set. The hand-written download-bytes
    // utility is the canonical path for bytes; this code handles future tools
    // that return content inline (e.g. recording-content with returnDownloadUrl).
    if (tool.returnDownloadUrl && path.endsWith('/content')) {
      path = path.replace(/\/content$/, '');
    } else if (path.includes('/content') || path.endsWith('/$value')) {
      requestOptions.rawResponse = true;
    }

    if (params.includeHeaders === true) requestOptions.includeHeaders = true;
    if (params.excludeResponse === true) requestOptions.excludeResponse = true;
    if (accountAccessToken) requestOptions.accessToken = accountAccessToken;

    const { accessToken: _redacted, ...safeOptions } = requestOptions;
    logger.info(
      `Making graph request to ${path} with options: ${JSON.stringify(safeOptions)}${_redacted ? ' [accessToken=REDACTED]' : ''}`
    );

    const response = await graphClient.graphRequest(path, requestOptions);

    const fetchAllPages = params.fetchAllPages === true;
    if (fetchAllPages && response?.content?.[0]?.text) {
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
        logger.error(`Error during pagination: ${e}`);
      }
    }

    return {
      content: response.content.map((item) => ({ type: 'text' as const, text: item.text })),
      _meta: response._meta,
      isError: response.isError,
    };
  } catch (error) {
    logger.error(`Error in tool ${tool.name}: ${(error as Error).message}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `Error in tool ${tool.name}: ${(error as Error).message}`,
          }),
        },
      ],
      isError: true,
    };
  }
}

function buildMcpParamSchema(
  tool: Tool,
  multiAccount: boolean,
  accountNames: string[]
): Record<string, z.ZodTypeAny> {
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

  if (multiAccount) {
    const accountHint =
      accountNames.length > 0 ? `Known accounts: ${accountNames.join(', ')}. ` : '';
    paramSchema['account'] = z
      .string()
      .describe(
        `${accountHint}Microsoft account email to use for this request. ` +
          `Required when multiple accounts are configured. ` +
          `Use the list-accounts tool to discover all currently available accounts.`
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
  ctx: UtilityToolContext
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
    async (params) => utility.execute(params, ctx)
  );
}

export function registerTools(
  server: McpServer,
  graphClient: GraphClient,
  authManager?: AuthManager,
  multiAccount: boolean = false,
  accountNames: string[] = []
): number {
  let registeredCount = 0;
  let failedCount = 0;

  for (const tool of ALL_TOOLS) {
    const description = tool.llmTip
      ? `${tool.description}\n\n💡 TIP: ${tool.llmTip}`
      : tool.description;

    try {
      server.tool(
        tool.name,
        description,
        buildMcpParamSchema(tool, multiAccount, accountNames),
        {
          title: tool.name,
          readOnlyHint: tool.method === 'GET',
          destructiveHint: ['POST', 'PATCH', 'DELETE'].includes(tool.method),
          openWorldHint: true,
        },
        async (params) => executeTool(tool, graphClient, authManager, params)
      );
      registeredCount++;
    } catch (error) {
      logger.error(`Failed to register tool ${tool.name}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  const utilityCtx: UtilityToolContext = {
    graphClient,
    authManager,
    multiAccount,
    accountNames,
  };
  for (const utility of utilityTools) {
    try {
      registerUtilityToolWithMcp(server, utility, utilityCtx);
      registeredCount++;
    } catch (error) {
      logger.error(`Failed to register tool ${utility.name}: ${(error as Error).message}`);
      failedCount++;
    }
  }

  if (multiAccount) {
    logger.info('Multi-account mode: "account" parameter injected into all tool schemas');
  }
  logger.info(`Tool registration complete: ${registeredCount} registered, ${failedCount} failed`);
  return registeredCount;
}

/** Test seam: lets tests invoke the runtime against a Tool definition without the McpServer registration path. */
export { executeTool };
