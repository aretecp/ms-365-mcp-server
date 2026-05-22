import { OData, type Tool } from './types.js';

export const identityTools: readonly Tool[] = [
  {
    name: 'get-me',
    description:
      "Get the signed-in user's profile (displayName, userPrincipalName, mail, jobTitle, etc.).",
    method: 'GET',
    path: '/me',
    scopes: ['User.Read'],
    params: [OData.select],
  },
];
