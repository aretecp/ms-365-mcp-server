import { z } from 'zod';
import { OData, type Tool } from './types.js';

const SITE_ID_HINT =
  'Site id is either the GUID returned by list-sites or the path form ' +
  '"<hostname>,<siteCollectionId>,<webId>" Graph documents. Use list-sites to discover it.';

const DRIVE_LISTING_TIP =
  "To fetch a file's bytes, use download-bytes with target " +
  '`/drives/{drive-id}/items/{item-id}/content`. The /me/drive tools (get-drive-root-item, ' +
  'list-folder-files, get-drive-item) cover OneDrive; these *-by-id variants cover SharePoint ' +
  'document libraries and any other drive you have access to.';

export const sharepointTools: readonly Tool[] = [
  // ---------- Sites ----------

  {
    name: 'list-sites',
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
    name: 'get-site',
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
    name: 'list-site-drives',
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
    name: 'list-drive-root-children',
    description:
      "List the items (files and folders) at the root of a drive by drive-id. Use this for any drive — SharePoint document library or a user's OneDrive — once you have the drive-id from list-site-drives.",
    method: 'GET',
    path: '/drives/{drive-id}/root/children',
    scopes: ['Sites.Read.All'],
    params: [
      { name: 'drive-id', location: 'path', schema: z.string().describe('Drive id') },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
    ],
    llmTip: DRIVE_LISTING_TIP,
  },
  {
    name: 'list-drive-folder-children',
    description:
      'List the items inside a folder in a specific drive, addressed by drive-id + folder item-id.',
    method: 'GET',
    path: '/drives/{drive-id}/items/{driveItem-id}/children',
    scopes: ['Sites.Read.All'],
    params: [
      { name: 'drive-id', location: 'path', schema: z.string().describe('Drive id') },
      {
        name: 'driveItem-id',
        location: 'path',
        schema: z.string().describe('Folder item id within the drive'),
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
    name: 'get-drive-item-by-id',
    description:
      'Get metadata for a single item (file or folder) in any drive, addressed by drive-id + item-id.',
    method: 'GET',
    path: '/drives/{drive-id}/items/{driveItem-id}',
    scopes: ['Sites.Read.All'],
    params: [
      { name: 'drive-id', location: 'path', schema: z.string().describe('Drive id') },
      {
        name: 'driveItem-id',
        location: 'path',
        schema: z.string().describe('Item id within the drive'),
      },
      OData.select,
      OData.expand,
    ],
  },

  // ---------- Lists in a site ----------

  {
    name: 'list-site-lists',
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
    name: 'list-site-list-items',
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
      'list-site-list-items defaults to $expand=fields so each row carries its column values. ' +
      'For wide lists, set $expand=fields($select=Title,Status,...) to scope which columns come back.',
  },
];
