/**
 * Minimal field projections applied server-side to read tools.
 *
 * A read tool declares `projection: <ResourceKind>` on its {@link Tool} def.
 * When the caller omits `$select` (and does not pass `response_format: 'detailed'`),
 * the runtime injects the resource's `Minimal*` field set so a careless call
 * cannot dump Graph's full 30–50-field object into the model context. The
 * caller can always pass an explicit `$select`, or `response_format: 'detailed'`,
 * to lift the projection.
 *
 * Keep these lists high-signal: the fields an agent needs to triage or to
 * obtain an id for a follow-up call. Full bodies / extended properties are an
 * opt-in (`detailed` or an explicit `$select`/`$expand`).
 */
export type ResourceKind = 'mail' | 'event' | 'driveItem' | 'user';

export const MINIMAL_SELECT: Record<ResourceKind, string> = {
  mail: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments',
  event: 'id,subject,start,end,organizer,attendees,isAllDay,onlineMeeting',
  driveItem: 'id,name,size,folder,file,webUrl,lastModifiedDateTime',
  user: 'id,displayName,userPrincipalName,mail,jobTitle,department',
};
