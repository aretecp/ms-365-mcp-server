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
];
