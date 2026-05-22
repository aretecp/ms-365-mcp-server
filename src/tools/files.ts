import { z } from 'zod';
import { OData, type Tool } from './types.js';

/**
 * v1 OneDrive surface, scoped to `/me/drive/...`. SharePoint (`/sites/...`)
 * and other-user drives are deferred to v1.5.
 */
export const filesTools: readonly Tool[] = [
  {
    name: 'get-drive-root-item',
    description:
      "Get the signed-in user's OneDrive root folder. The returned id is the parent for list-folder-files at the top level.",
    method: 'GET',
    path: '/me/drive/root',
    scopes: ['Files.Read'],
    params: [OData.select, OData.expand],
  },
  {
    name: 'list-folder-files',
    description:
      'List child items (files and folders) of a OneDrive folder by item id. Use get-drive-root-item first to find the root id, or pass a folder id returned from a previous list.',
    method: 'GET',
    path: '/me/drive/items/{item-id}/children',
    scopes: ['Files.Read'],
    params: [
      {
        name: 'item-id',
        location: 'path',
        schema: z.string().describe('Drive item id of the folder to list'),
      },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
      OData.count,
      OData.expand,
    ],
    llmTip:
      'Files vs folders: items with a `folder` facet are folders; items with a `file` facet are files. ' +
      "To fetch a file's bytes, call download-bytes with target `/me/drive/items/{item-id}/content`.",
  },
  {
    name: 'get-drive-item',
    description: 'Get metadata for a OneDrive item (file or folder) by id.',
    method: 'GET',
    path: '/me/drive/items/{item-id}',
    scopes: ['Files.Read'],
    params: [
      {
        name: 'item-id',
        location: 'path',
        schema: z.string().describe('Drive item id'),
      },
      OData.select,
      OData.expand,
    ],
  },
];
