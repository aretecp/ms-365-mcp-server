import { z } from 'zod';
import type GraphClient from '../graph-client.js';
import { OData, type Tool, type ToolPrecondition } from './types.js';

/**
 * Server-side guard: refuses the tool call unless the referenced message is a
 * draft. Mail.ReadWrite covers the entire mailbox at the Graph layer — this
 * guard narrows write capability to drafts for tools whose description says
 * "draft" but whose underlying endpoint accepts any message id.
 *
 * Performs a tiny GET with $select=isDraft to avoid pulling the message body.
 * If the GET 404s, the original tool call would have 404'd anyway — re-throw
 * a clear message so the model can correct.
 */
const assertIsDraft: ToolPrecondition = async (
  graphClient: GraphClient,
  params: Record<string, unknown>
) => {
  const id = params['message-id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('message-id is required and must be a non-empty string.');
  }
  const path = `/me/messages/${encodeURIComponent(id)}?$select=isDraft`;
  let msg: { isDraft?: boolean } | null;
  try {
    msg = (await graphClient.graphRequest(path, { method: 'GET' })) as {
      isDraft?: boolean;
    } | null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not verify message is a draft (lookup failed: ${message}). The message may not exist or the signed-in user may not have access.`
    );
  }
  if (!msg || msg.isDraft !== true) {
    throw new Error(
      `message '${id}' is not a draft (isDraft=${String(msg?.isDraft)}). ` +
        'This tool refuses to modify non-draft mail. Create a fresh draft with create-draft-email instead, or have the human action the message in Outlook.'
    );
  }
};

const MAIL_SEARCH_TIP =
  'CRITICAL: When searching emails, the $search parameter value MUST be wrapped in double quotes. ' +
  'Format: $search="your search query here". Use KQL (Keyword Query Language) syntax to search ' +
  "specific properties: 'from:', 'subject:', 'body:', 'to:', 'cc:', 'bcc:', 'attachment:', " +
  "'hasAttachments:', 'importance:', 'received:', 'sent:'. " +
  'Examples: $search="from:john@example.com" | $search="subject:meeting AND hasAttachments:true" | ' +
  '$search="body:urgent AND received>=2024-01-01" | $search="from:john AND importance:high". ' +
  'Reference: https://learn.microsoft.com/en-us/graph/search-query-parameter ' +
  'IMPORTANT: Always use $select to limit returned fields and reduce response size. Recommended default: ' +
  '$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments. ' +
  'Use bodyPreview instead of body for listings. To read the full email body, use get-mail-message with the specific message id.';

/**
 * Outlook recipient: `{ emailAddress: { address, name? } }`. Reused by both
 * to/cc/bcc recipient arrays. `.passthrough()` so Graph extensions don't
 * fail validation.
 */
const emailAddressSchema = z
  .object({
    emailAddress: z
      .object({
        address: z.string().describe('SMTP address (e.g. user@example.com)'),
        name: z.string().optional().describe('Display name'),
      })
      .passthrough(),
  })
  .passthrough();

/** ItemBody on a Message. `contentType` is `text` or `html`. */
const itemBodySchema = z
  .object({
    contentType: z.enum(['text', 'html', 'Text', 'HTML']).describe('text or html'),
    content: z.string().describe('Body content in the chosen contentType'),
  })
  .passthrough();

/**
 * Mutable Message resource. Used as the body shape for create-draft-email
 * and (in partial form) update-mail-message. Field set kept narrow and
 * commonly-needed; `.passthrough()` allows the LLM to send extras Graph
 * supports without a schema-update round-trip.
 */
const messageWriteSchema = z
  .object({
    subject: z.string().optional(),
    body: itemBodySchema.optional(),
    toRecipients: z.array(emailAddressSchema).optional(),
    ccRecipients: z.array(emailAddressSchema).optional(),
    bccRecipients: z.array(emailAddressSchema).optional(),
    replyTo: z.array(emailAddressSchema).optional(),
    importance: z.enum(['low', 'normal', 'high']).optional(),
    isRead: z.boolean().optional(),
    categories: z.array(z.string()).optional(),
    internetMessageHeaders: z
      .array(z.object({ name: z.string(), value: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

/**
 * FileAttachment write shape: `@odata.type` MUST be
 * `#microsoft.graph.fileAttachment`; `contentBytes` is base64. For ItemAttachment
 * / ReferenceAttachment, pass the appropriate @odata.type and additional fields
 * via .passthrough().
 */
const attachmentWriteSchema = z
  .object({
    '@odata.type': z
      .string()
      .describe(
        'Attachment subtype. Use #microsoft.graph.fileAttachment for bytes, ' +
          '#microsoft.graph.itemAttachment to attach another message/event, ' +
          '#microsoft.graph.referenceAttachment for a link.'
      ),
    name: z.string().describe('Display name of the attachment'),
    contentType: z.string().optional().describe('MIME type'),
    contentBytes: z
      .string()
      .optional()
      .describe('Base64-encoded file bytes (required for fileAttachment).'),
    contentId: z.string().optional(),
    isInline: z.boolean().optional(),
  })
  .passthrough();

export const mailTools: readonly Tool[] = [
  {
    name: 'list-mail-messages',
    description: "List the signed-in user's mail messages.",
    method: 'GET',
    path: '/me/messages',
    scopes: ['Mail.Read'],
    projection: 'mail',
    params: [
      OData.filter,
      OData.search,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
      OData.count,
      OData.expand,
    ],
    llmTip: MAIL_SEARCH_TIP,
  },
  {
    name: 'get-mail-message',
    description: 'Get a mail message by id, including the full body.',
    method: 'GET',
    path: '/me/messages/{message-id}',
    scopes: ['Mail.Read'],
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Mail message id'),
      },
      OData.select,
      OData.expand,
    ],
  },
  {
    name: 'list-mail-folders',
    description: "List the signed-in user's top-level mail folders.",
    method: 'GET',
    path: '/me/mailFolders',
    scopes: ['Mail.Read'],
    params: [OData.filter, OData.select, OData.orderby, OData.top, OData.skip, OData.count],
  },
  {
    name: 'list-mail-folder-messages',
    description: 'List messages inside a specific mail folder.',
    method: 'GET',
    path: '/me/mailFolders/{mailFolder-id}/messages',
    scopes: ['Mail.Read'],
    projection: 'mail',
    params: [
      {
        name: 'mailFolder-id',
        location: 'path',
        schema: z.string().describe('Mail folder id (use list-mail-folders to discover)'),
      },
      OData.filter,
      OData.search,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
      OData.count,
      OData.expand,
    ],
    llmTip: MAIL_SEARCH_TIP,
  },
  {
    name: 'list-mail-attachments',
    description:
      'List attachments on a mail message. Use download-bytes with the attachment $value path to fetch bytes.',
    method: 'GET',
    path: '/me/messages/{message-id}/attachments',
    scopes: ['Mail.Read'],
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Mail message id'),
      },
      OData.select,
      OData.top,
      OData.skip,
    ],
  },

  // ---------- Write tools (PR 4) ----------

  {
    name: 'create-draft-email',
    description:
      "Create a draft email in the signed-in user's Drafts folder. Returns the new message including its id. The draft sits in Drafts until the human opens Outlook and clicks Send — this server has no send capability (see docs/DEPLOYMENT.md §3 on the deliberate Mail.Send exclusion).",
    method: 'POST',
    path: '/me/messages',
    scopes: ['Mail.ReadWrite'],
    params: [
      {
        name: 'body',
        location: 'body',
        schema: messageWriteSchema,
      },
    ],
    llmTip:
      'Resolve recipient addresses with list-users (or a known contact) before drafting; do not invent SMTP addresses. ' +
      'For HTML bodies set body.contentType to "html"; otherwise "text". ' +
      'After creating the draft, tell the human it is waiting in their Drafts folder for review — the model cannot send it.',
  },
  {
    name: 'update-mail-message',
    description:
      'Update fields on a draft mail message by id. Any field omitted is left unchanged. The server refuses this call if the message is not a draft (isDraft=true) — non-drafts must be actioned by the human in Outlook.',
    method: 'PATCH',
    path: '/me/messages/{message-id}',
    scopes: ['Mail.ReadWrite'],
    precondition: assertIsDraft,
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Draft message id (must satisfy isDraft=true)'),
      },
      {
        name: 'body',
        location: 'body',
        schema: messageWriteSchema,
      },
    ],
  },
  {
    name: 'add-mail-attachment',
    description:
      'Add an attachment to a draft message. For files under 3 MB pass base64 in contentBytes; for larger files use Graph upload sessions (not exposed in v1). The server refuses this call if the message is not a draft.',
    method: 'POST',
    path: '/me/messages/{message-id}/attachments',
    scopes: ['Mail.ReadWrite'],
    precondition: assertIsDraft,
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Draft message id (must satisfy isDraft=true)'),
      },
      {
        name: 'body',
        location: 'body',
        schema: attachmentWriteSchema,
      },
    ],
  },
  {
    name: 'delete-mail-message',
    description:
      'Move a draft mail message to Deleted Items by id. The server refuses this call if the message is not a draft — received and sent mail must be actioned by the human in Outlook (the LLM cannot mass-delete an inbox via this tool).',
    method: 'DELETE',
    path: '/me/messages/{message-id}',
    scopes: ['Mail.ReadWrite'],
    precondition: assertIsDraft,
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Draft message id (must satisfy isDraft=true)'),
      },
    ],
  },
];
