import { z } from 'zod';
import { OData, type Tool } from './types.js';

const SITE_ID_HINT =
  'Site id is either the GUID returned by sharepoint-site-list or the path form ' +
  '"<hostname>,<siteCollectionId>,<webId>" Graph documents. Use sharepoint-site-list to discover it.';

const DRIVE_LISTING_TIP =
  "To fetch a file's bytes, use download-bytes with target " +
  '`/drives/{drive-id}/items/{item-id}/content`. The OneDrive tools (drive-children-list, ' +
  'drive-item-get) cover the signed-in user\'s OneDrive; these sharepoint-drive-* tools cover ' +
  'SharePoint document libraries and any other drive you have access to.';

export const sharepointTools: readonly Tool[] = [
  // ---------- Sites ----------

  {
    name: 'sharepoint-site-list',
    description:
      'Search SharePoint sites in the tenant. Always pass a search query — Graph returns nearly nothing without one.',
    method: 'GET',
    path: '/sites',
    scopes: ['Sites.Read.All'],
    params: [
      {
        name: 'search',
        location: 'query',
        schema: z
          .string()
          .describe(
            'Search query, e.g. "Finance" or "Areté Intelligence Team Site". Plain keyword search, not OData $search.'
          )
          .optional(),
      },
      OData.select,
      OData.top,
      OData.skip,
    ],
    llmTip:
      'The `search` query parameter here is a plain SharePoint search keyword (not OData $search). ' +
      'Returns sites matching the keyword in title, URL, or content. ' +
      'Use $select=id,name,displayName,webUrl to keep responses small.',
  },
  {
    name: 'sharepoint-site-get',
    description: 'Get a single SharePoint site by id.',
    method: 'GET',
    path: '/sites/{site-id}',
    scopes: ['Sites.Read.All'],
    params: [
      {
        name: 'site-id',
        location: 'path',
        schema: z.string().describe(SITE_ID_HINT),
      },
      OData.select,
      OData.expand,
    ],
  },

  // ---------- Drives in a site ----------

  {
    name: 'sharepoint-drive-list',
    description:
      'List the document libraries (drives) inside a SharePoint site. A site can have multiple drives — most commonly "Documents" plus any custom libraries.',
    method: 'GET',
    path: '/sites/{site-id}/drives',
    scopes: ['Sites.Read.All'],
    params: [
      {
        name: 'site-id',
        location: 'path',
        schema: z.string().describe(SITE_ID_HINT),
      },
      OData.select,
      OData.top,
      OData.skip,
    ],
  },

  // ---------- Drive contents (any drive by id) ----------

  {
    name: 'sharepoint-drive-children-list',
    description:
      "List items (files and folders) in a SharePoint document library or any drive by drive-id (from sharepoint-drive-list). Omit driveItem-id for the drive root; pass a folder driveItem-id to list inside it. For the signed-in user's OneDrive, use drive-children-list instead.",
    method: 'GET',
    path: '/drives/{drive-id}/root/children',
    scopes: ['Sites.Read.All'],
    projection: 'driveItem',
    resolverParams: ['drive-id', 'driveItem-id'],
    pathResolver: (p) => {
      const drive = encodeURIComponent(String(p['drive-id'] ?? ''));
      return typeof p['driveItem-id'] === 'string' && p['driveItem-id'].length > 0
        ? `/drives/${drive}/items/${encodeURIComponent(p['driveItem-id'])}/children`
        : `/drives/${drive}/root/children`;
    },
    params: [
      { name: 'drive-id', location: 'query', schema: z.string().describe('Drive id (from sharepoint-drive-list)') },
      {
        name: 'driveItem-id',
        location: 'query',
        schema: z
          .string()
          .describe('Optional folder item id within the drive. Omit for the drive root.')
          .optional(),
      },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
    ],
    llmTip: DRIVE_LISTING_TIP,
  },
  {
    name: 'sharepoint-drive-item-get',
    description:
      'Get metadata for a single item (file or folder) in a SharePoint document library or any drive by drive-id. Omit driveItem-id for the drive root item; pass an item-id for a specific item.',
    method: 'GET',
    path: '/drives/{drive-id}/root',
    scopes: ['Sites.Read.All'],
    projection: 'driveItem',
    resolverParams: ['drive-id', 'driveItem-id'],
    pathResolver: (p) => {
      const drive = encodeURIComponent(String(p['drive-id'] ?? ''));
      return typeof p['driveItem-id'] === 'string' && p['driveItem-id'].length > 0
        ? `/drives/${drive}/items/${encodeURIComponent(p['driveItem-id'])}`
        : `/drives/${drive}/root`;
    },
    params: [
      { name: 'drive-id', location: 'query', schema: z.string().describe('Drive id (from sharepoint-drive-list)') },
      {
        name: 'driveItem-id',
        location: 'query',
        schema: z
          .string()
          .describe('Optional item id within the drive. Omit for the drive root item.')
          .optional(),
      },
      OData.select,
      OData.expand,
    ],
  },

  // ---------- Lists in a site ----------

  {
    name: 'sharepoint-list-list',
    description:
      'List the SharePoint lists in a site. Lists are structured-data tables (distinct from document libraries, which are file storage).',
    method: 'GET',
    path: '/sites/{site-id}/lists',
    scopes: ['Sites.Read.All'],
    params: [
      {
        name: 'site-id',
        location: 'path',
        schema: z.string().describe(SITE_ID_HINT),
      },
      OData.filter,
      OData.select,
      OData.top,
      OData.skip,
    ],
  },
  {
    name: 'sharepoint-list-item-list',
    description:
      'List rows in a SharePoint list. Always returns items with their column values expanded ($expand=fields) — list items are nearly useless without their fields.',
    method: 'GET',
    path: '/sites/{site-id}/lists/{list-id}/items',
    scopes: ['Sites.Read.All'],
    params: [
      {
        name: 'site-id',
        location: 'path',
        schema: z.string().describe(SITE_ID_HINT),
      },
      { name: 'list-id', location: 'path', schema: z.string().describe('List id') },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
      // Override the shared $expand description with list-specific guidance.
      {
        name: 'expand',
        location: 'query',
        schema: z
          .string()
          .describe(
            'Defaults to "fields" if you do not set it (caller-set value wins). ' +
              'For large lists, narrow with fields($select=Title,Status,Owner) to keep responses small.'
          )
          .optional(),
      },
    ],
    llmTip:
      'sharepoint-list-item-list defaults to $expand=fields so each row carries its column values. ' +
      'For wide lists, set $expand=fields($select=Title,Status,...) to scope which columns come back.',
  },
];
