import { z } from 'zod';
import { OData, type Tool, type ToolPrecondition } from './types.js';

/**
 * Guard for online-meeting-find: exactly one lookup key (meeting-id OR
 * join-web-url). A usage invariant, not a security boundary — the Graph call is
 * read-only either way; this just refuses an ambiguous/empty lookup in code so
 * the model gets a clear error instead of a confusing Graph response.
 */
const assertExactlyOneMeetingKey: ToolPrecondition = async (_graphClient, params) => {
  const hasId = typeof params['meeting-id'] === 'string' && params['meeting-id'].length > 0;
  const hasUrl = typeof params['join-web-url'] === 'string' && params['join-web-url'].length > 0;
  if (hasId === hasUrl) {
    throw new Error(
      `online-meeting-find requires exactly one of meeting-id or join-web-url (got ${hasId ? 'both' : 'neither'}).`
    );
  }
};

/** Body shape on a Teams chatMessage. HTML is the Teams default for client display. */
const messageItemBodySchema = z
  .object({
    contentType: z
      .enum(['html', 'text', 'HTML', 'Text'])
      .describe('html or text. HTML is preferred for Teams.'),
    content: z
      .string()
      .describe(
        'Body content. For mentions, embed <at id="N">Name</at> spans and supply matching entries in mentions[].'
      ),
  })
  .passthrough();

/**
 * Embedded mention. For each `<at id="N">Name</at>` span in the body, supply a
 * matching mention entry. `mentioned.user.id` is the Entra object id (not the UPN).
 */
const mentionSchema = z
  .object({
    id: z.number().int().describe('Numeric id matching the <at id="N"> span in the body.'),
    mentionText: z.string().describe('Display text inside the <at> span.'),
    mentioned: z
      .object({
        user: z
          .object({
            id: z.string().describe('Entra object id of the mentioned user.'),
            displayName: z.string().optional(),
            userIdentityType: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Mutable chatMessage shape used by send-chat-message / send-channel-message /
 * send-channel-message-reply. Same resource on all three endpoints; channel
 * posts can additionally set `subject` to start a thread with a title.
 */
const chatMessageWriteSchema = z
  .object({
    body: messageItemBodySchema,
    subject: z
      .string()
      .optional()
      .describe('Channel thread subject. Ignored for chat messages and channel replies.'),
    importance: z.enum(['normal', 'high', 'urgent']).optional(),
    mentions: z.array(mentionSchema).optional(),
    attachments: z
      .array(
        z
          .object({
            id: z.string(),
            contentType: z.string(),
            contentUrl: z.string().optional(),
            name: z.string().optional(),
            thumbnailUrl: z.string().optional(),
          })
          .passthrough()
      )
      .optional()
      .describe('Adaptive cards or hosted-content references. Most use cases do not need this.'),
  })
  .passthrough();

/**
 * Meeting participants: Entra user ids, NOT email addresses. (Graph asymmetry
 * vs calendar event attendees, which use SMTP.)
 */
const meetingParticipantSchema = z
  .object({
    identity: z
      .object({
        user: z
          .object({
            id: z.string().describe('Entra object id'),
            displayName: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    upn: z.string().optional(),
    role: z
      .enum(['attendee', 'presenter', 'producer', 'coorganizer'])
      .optional()
      .describe('Defaults to attendee.'),
  })
  .passthrough();

const onlineMeetingWriteSchema = z
  .object({
    subject: z.string().optional(),
    startDateTime: z
      .string()
      .optional()
      .describe(
        'ISO 8601, e.g. 2026-05-23T14:00:00Z. Bare timestamps — not the {dateTime,timeZone} wrapper calendar events use.'
      ),
    endDateTime: z.string().optional(),
    participants: z
      .object({
        organizer: meetingParticipantSchema.optional(),
        attendees: z.array(meetingParticipantSchema).optional(),
      })
      .passthrough()
      .optional(),
    isBroadcast: z.boolean().optional(),
    allowMeetingChat: z.enum(['enabled', 'disabled', 'limited']).optional(),
    allowedPresenters: z
      .enum(['everyone', 'organization', 'roleIsPresenter', 'organizer'])
      .optional(),
    allowAttendeeToEnableCamera: z.boolean().optional(),
    allowAttendeeToEnableMic: z.boolean().optional(),
    recordAutomatically: z.boolean().optional(),
  })
  .passthrough();

const MENTION_TIP =
  'To @-mention a user: embed <at id="0">Name</at> in body.content and supply a matching ' +
  'mentions[0] = { id: 0, mentionText: "Name", mentioned: { user: { id: "<entra-oid>" } } }. ' +
  'Use get-me or list-users (when exposed) to resolve Entra object ids; do not invent them.';

const CREATE_MEETING_TIP =
  'create-online-meeting mints a joinWebUrl but does NOT put the meeting on the calendar. ' +
  'For "schedule a meeting" workflows, prefer create-calendar-event with isOnlineMeeting: true — ' +
  'Graph will create the underlying Teams meeting and attach it to the event in one step. ' +
  'Use create-online-meeting only when you need a join URL without a corresponding calendar entry.';

export const teamsTools: readonly Tool[] = [
  // ---------- Chats (read) ----------

  {
    name: 'list-chats',
    description:
      "List the signed-in user's chats (one-on-one, group, and meeting chats). For a quick 'recent chats' summary, $expand=lastMessagePreview and $top=10.",
    method: 'GET',
    path: '/me/chats',
    scopes: ['Chat.ReadBasic'],
    params: [OData.filter, OData.select, OData.orderby, OData.top, OData.skip, OData.expand],
    llmTip:
      'Useful $expand values: lastMessagePreview (most-recent message snippet), members (chat participants). ' +
      "Filter by chatType eq 'oneOnOne' or 'group' or 'meeting' to narrow.",
  },
  {
    name: 'get-chat',
    description: 'Get a single chat by id. Pair with $expand=members to see participants.',
    method: 'GET',
    path: '/chats/{chat-id}',
    scopes: ['Chat.Read'],
    params: [
      { name: 'chat-id', location: 'path', schema: z.string().describe('Chat id') },
      OData.select,
      OData.expand,
    ],
  },
  {
    name: 'list-chat-messages',
    description:
      'List messages in a chat. Chats are flat — there is no thread/reply structure (channels have that). Returns messages newest-first by default.',
    method: 'GET',
    path: '/chats/{chat-id}/messages',
    scopes: ['Chat.Read'],
    params: [
      { name: 'chat-id', location: 'path', schema: z.string().describe('Chat id') },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
    ],
  },
  {
    name: 'get-chat-message',
    description: 'Get a single chat message by id, including the full body.',
    method: 'GET',
    path: '/chats/{chat-id}/messages/{chatMessage-id}',
    scopes: ['Chat.Read'],
    params: [
      { name: 'chat-id', location: 'path', schema: z.string().describe('Chat id') },
      { name: 'chatMessage-id', location: 'path', schema: z.string().describe('Chat message id') },
      OData.select,
    ],
  },

  // ---------- Teams + channels (read) ----------

  {
    name: 'list-joined-teams',
    description: 'List the Teams the signed-in user is a member of.',
    method: 'GET',
    path: '/me/joinedTeams',
    scopes: ['Team.ReadBasic.All'],
    params: [OData.select, OData.top, OData.skip],
  },
  {
    name: 'list-team-channels',
    description: 'List the channels in a team.',
    method: 'GET',
    path: '/teams/{team-id}/channels',
    scopes: ['Channel.ReadBasic.All'],
    params: [
      { name: 'team-id', location: 'path', schema: z.string().describe('Team id') },
      OData.filter,
      OData.select,
      OData.top,
      OData.skip,
    ],
  },
  {
    name: 'list-channel-messages',
    description:
      'List top-level messages (thread roots) in a channel. Use list-channel-message-replies to drill into a specific thread.',
    method: 'GET',
    path: '/teams/{team-id}/channels/{channel-id}/messages',
    scopes: ['ChannelMessage.Read.All'],
    params: [
      { name: 'team-id', location: 'path', schema: z.string().describe('Team id') },
      { name: 'channel-id', location: 'path', schema: z.string().describe('Channel id') },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
    ],
    llmTip:
      'ChannelMessage.Read.All is broad — it reads across every channel the user is in. ' +
      'Start with $top=10 + $select=id,from,subject,body,createdDateTime to keep the response small.',
  },
  {
    name: 'get-channel-message',
    description: 'Get a single channel message (thread root) by id.',
    method: 'GET',
    path: '/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}',
    scopes: ['ChannelMessage.Read.All'],
    params: [
      { name: 'team-id', location: 'path', schema: z.string().describe('Team id') },
      { name: 'channel-id', location: 'path', schema: z.string().describe('Channel id') },
      {
        name: 'chatMessage-id',
        location: 'path',
        schema: z.string().describe('Channel message (thread root) id'),
      },
      OData.select,
    ],
  },
  {
    name: 'list-channel-message-replies',
    description: 'List replies to a thread root in a channel.',
    method: 'GET',
    path: '/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies',
    scopes: ['ChannelMessage.Read.All'],
    params: [
      { name: 'team-id', location: 'path', schema: z.string().describe('Team id') },
      { name: 'channel-id', location: 'path', schema: z.string().describe('Channel id') },
      {
        name: 'chatMessage-id',
        location: 'path',
        schema: z.string().describe('Channel message (thread root) id'),
      },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
    ],
  },

  // ---------- Online meetings (read) ----------

  {
    name: 'online-meeting-find',
    description:
      "Resolve a single online meeting by id OR by joinWebUrl (pass exactly one). Use meeting-id when you already have it; use join-web-url for a user-supplied Teams link (normalize it with parse-teams-url first). Returns the meeting metadata including id. Replaces the old find-online-meeting + get-online-meeting pair.",
    method: 'GET',
    path: '/me/onlineMeetings',
    scopes: ['OnlineMeetings.Read'],
    precondition: assertExactlyOneMeetingKey,
    resolverParams: ['meeting-id', 'join-web-url'],
    pathResolver: (p) => {
      const id = p['meeting-id'];
      if (typeof id === 'string' && id.length > 0) {
        return `/me/onlineMeetings/${encodeURIComponent(id)}`;
      }
      const url = String(p['join-web-url'] ?? '');
      // Build the $filter in code so the model never hand-writes OData.
      return `/me/onlineMeetings?$filter=${encodeURIComponent(`joinWebUrl eq '${url}'`)}`;
    },
    params: [
      {
        name: 'meeting-id',
        location: 'query',
        schema: z.string().describe('Online meeting id. Provide this OR join-web-url, not both.').optional(),
      },
      {
        name: 'join-web-url',
        location: 'query',
        schema: z
          .string()
          .describe('Teams joinWebUrl (from parse-teams-url). Provide this OR meeting-id, not both.')
          .optional(),
      },
      OData.select,
    ],
    llmTip: 'Pair with parse-teams-url to normalize a user-supplied Teams link before passing join-web-url.',
  },
  {
    name: 'list-meeting-transcripts',
    description:
      'List transcripts for an online meeting. Returns metadata only — use download-bytes against {transcript.transcriptContentUrl} or /users/{user-id}/onlineMeetings/{meeting-id}/transcripts/{transcript-id}/content for the VTT bytes.',
    method: 'GET',
    path: '/me/onlineMeetings/{meeting-id}/transcripts',
    scopes: ['OnlineMeetingTranscript.Read.All'],
    params: [
      { name: 'meeting-id', location: 'path', schema: z.string().describe('Online meeting id') },
      OData.select,
      OData.top,
      OData.skip,
    ],
    llmTip:
      'OnlineMeetingTranscript.Read.All requires admin consent (already granted on the Areté Entra app). ' +
      'For the actual transcript text, call download-bytes with the transcript id and acceptType "text/vtt".',
  },

  // ---------- Writes ----------

  {
    name: 'send-chat-message',
    description:
      'Send a new message to a chat. Returns the created message including its id. Pair with list-chats to find the chat-id.',
    method: 'POST',
    path: '/chats/{chat-id}/messages',
    scopes: ['ChatMessage.Send'],
    params: [
      { name: 'chat-id', location: 'path', schema: z.string().describe('Chat id') },
      { name: 'body', location: 'body', schema: chatMessageWriteSchema },
    ],
    llmTip:
      'Prefer body.contentType: "html" — plain text often renders oddly in Teams. ' + MENTION_TIP,
  },
  {
    name: 'send-channel-message',
    description:
      'Start a new thread in a channel by sending a top-level message. Returns the created message; use its id with send-channel-message-reply to add replies. Set body.subject to give the thread a title.',
    method: 'POST',
    path: '/teams/{team-id}/channels/{channel-id}/messages',
    scopes: ['ChannelMessage.Send'],
    params: [
      { name: 'team-id', location: 'path', schema: z.string().describe('Team id') },
      { name: 'channel-id', location: 'path', schema: z.string().describe('Channel id') },
      { name: 'body', location: 'body', schema: chatMessageWriteSchema },
    ],
    llmTip:
      'Channel posts vs replies: this endpoint starts a new thread. Use send-channel-message-reply ' +
      'to add to an existing thread. ' +
      MENTION_TIP,
  },
  {
    name: 'send-channel-message-reply',
    description:
      'Add a reply to an existing channel thread. Use list-channel-messages to find the thread root id.',
    method: 'POST',
    path: '/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies',
    scopes: ['ChannelMessage.Send'],
    params: [
      { name: 'team-id', location: 'path', schema: z.string().describe('Team id') },
      { name: 'channel-id', location: 'path', schema: z.string().describe('Channel id') },
      {
        name: 'chatMessage-id',
        location: 'path',
        schema: z.string().describe('Thread root message id'),
      },
      { name: 'body', location: 'body', schema: chatMessageWriteSchema },
    ],
    llmTip: 'Subject on replies is ignored — the thread already has one. ' + MENTION_TIP,
  },
  {
    name: 'create-online-meeting',
    description:
      'Create a Teams online meeting. Returns the meeting including its joinWebUrl. Does NOT add the meeting to the calendar.',
    method: 'POST',
    path: '/me/onlineMeetings',
    scopes: ['OnlineMeetings.ReadWrite'],
    params: [{ name: 'body', location: 'body', schema: onlineMeetingWriteSchema }],
    llmTip: CREATE_MEETING_TIP,
  },
  {
    name: 'update-online-meeting',
    description:
      'Update fields on a Teams online meeting by id. Omitted fields are left unchanged.',
    method: 'PATCH',
    path: '/me/onlineMeetings/{meeting-id}',
    scopes: ['OnlineMeetings.ReadWrite'],
    params: [
      { name: 'meeting-id', location: 'path', schema: z.string().describe('Online meeting id') },
      { name: 'body', location: 'body', schema: onlineMeetingWriteSchema },
    ],
  },
  {
    name: 'delete-online-meeting',
    description:
      'Delete a Teams online meeting by id. The meeting becomes inaccessible to attendees; if there is a corresponding calendar event, delete it separately with delete-calendar-event.',
    method: 'DELETE',
    path: '/me/onlineMeetings/{meeting-id}',
    scopes: ['OnlineMeetings.ReadWrite'],
    params: [
      { name: 'meeting-id', location: 'path', schema: z.string().describe('Online meeting id') },
    ],
  },
];
