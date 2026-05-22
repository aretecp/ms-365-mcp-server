import { z } from 'zod';
import type GraphClient from '../graph-client.js';
import { parseTeamsUrl } from '../lib/teams-url-parser.js';

type ContentItem = { type: 'text'; text: string; [key: string]: unknown };

export interface CallToolResult {
  content: ContentItem[];
  _meta?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface UtilityToolContext {
  graphClient: GraphClient;
}

/**
 * Server-side tools that don't map 1:1 to a Graph endpoint — either they
 * synthesize/normalize input (parse-teams-url) or they touch Graph in a way
 * that doesn't fit the request-shaping the Tool runtime does (download-bytes
 * takes a free-form Graph path).
 */
export interface UtilityTool {
  name: string;
  /** Display-only HTTP method. `tool:` prefix on `path` marks it as non-Graph. */
  method: string;
  /** Display-only synthetic path; never used to construct a Graph URL. */
  path: string;
  description: string;
  buildSchema: (ctx: UtilityToolContext) => Record<string, z.ZodTypeAny>;
  execute: (params: Record<string, unknown>, ctx: UtilityToolContext) => Promise<CallToolResult>;
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
}

export const utilityTools: readonly UtilityTool[] = [
  {
    name: 'parse-teams-url',
    method: 'POST',
    path: 'tool:parse-teams-url',
    description:
      'Converts any Teams meeting URL format (short /meet/, full /meetup-join/, or recap ?threadId=) into a standard joinWebUrl. Use this before list-online-meetings when the user provides a recap or short URL.',
    readOnlyHint: true,
    openWorldHint: false,
    buildSchema: () => ({
      url: z.string().describe('Teams meeting URL in any format'),
    }),
    execute: async (params) => {
      const url = params.url;
      if (typeof url !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'url is required.' }) }],
          isError: true,
        };
      }
      try {
        const joinWebUrl = parseTeamsUrl(url);
        return { content: [{ type: 'text', text: joinWebUrl }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    },
  },
  {
    name: 'download-bytes',
    method: 'GET',
    path: 'tool:download-bytes',
    description:
      'Download binary content from Microsoft Graph and return it as base64. Single tool for any binary read: drive file content, mail attachment, profile photo, Teams hosted content. Returns { contentType, encoding: "base64", contentLength, contentBytes }.',
    readOnlyHint: true,
    openWorldHint: true,
    buildSchema: () => ({
      target: z
        .string()
        .describe(
          'Relative Microsoft Graph path starting with "/". Common paths: ' +
            '/me/drive/items/{driveItem-id}/content (OneDrive file content); ' +
            '/me/messages/{message-id}/attachments/{attachment-id}/$value (mail attachment, list-mail-attachments returns the IDs); ' +
            '/me/photo/$value or /users/{user-id}/photo/$value (profile photo); ' +
            '/chats/{chat-id}/messages/{chatMessage-id}/hostedContents/{chatMessageHostedContent-id}/$value (Teams chat hosted content); ' +
            '/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/hostedContents/{chatMessageHostedContent-id}/$value (Teams channel hosted content).'
        ),
    }),
    execute: async (params, { graphClient }) => {
      const target = params.target;
      if (typeof target !== 'string' || target.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'target is required and must be a non-empty string.' }),
            },
          ],
          isError: true,
        };
      }
      if (!target.startsWith('/')) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'target must be a relative Microsoft Graph path starting with "/", e.g. /me/photo/$value or /me/drive/items/{driveItem-id}/content. Absolute URLs are not accepted; if you have an @microsoft.graph.downloadUrl, use the equivalent /content or /$value path instead (Graph 302-redirects to the same bytes).',
              }),
            },
          ],
          isError: true,
        };
      }
      try {
        return await graphClient.graphRequest(target);
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    },
  },
];
