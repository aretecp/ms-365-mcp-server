import { z } from 'zod';
import { OData, type Tool } from './types.js';

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
      'Update fields on a mail message (draft) by id. Any field omitted is left unchanged. Use create-draft-email to start a new draft and this to amend it; sending is done by the human from Outlook (no send tool exists).',
    method: 'PATCH',
    path: '/me/messages/{message-id}',
    scopes: ['Mail.ReadWrite'],
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Draft message id'),
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
      'Add an attachment to a draft message. For files under 3 MB pass base64 in contentBytes; for larger files use Graph upload sessions (not exposed in v1).',
    method: 'POST',
    path: '/me/messages/{message-id}/attachments',
    scopes: ['Mail.ReadWrite'],
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Draft message id'),
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
      'Move a mail message to Deleted Items by id. Irreversible from the API perspective — restoration requires user action in Outlook. Use sparingly.',
    method: 'DELETE',
    path: '/me/messages/{message-id}',
    scopes: ['Mail.ReadWrite'],
    params: [
      {
        name: 'message-id',
        location: 'path',
        schema: z.string().describe('Mail message id'),
      },
    ],
  },
];
