# Security Audit — Tool Surface vs. Graph Capability

This document enumerates the audit performed in response to
[issue #11](https://github.com/aretecp/ms-365-mcp-server/issues/11). For
every write tool in the surface (POST / PATCH / DELETE), we record:

1. The exact Graph endpoint the tool calls.
2. What Microsoft Graph accepts at the granted scope.
3. What the tool description claims (the narrower contract).
4. The gap (actions the model could take that violate the description but
   that Graph would accept) — or a "no gap" finding if Graph's natural
   scoping already covers the description's claim.
5. The proposed precondition / runtime guard, if a gap exists.
6. The follow-up issue tracking the fix, if filed.

The mechanism for closing gaps is `Tool.precondition` in
[`src/tools/types.ts`](../src/tools/types.ts), invoked by the runtime in
[`src/tool-runtime.ts`](../src/tool-runtime.ts) before any outbound Graph
call. Tool descriptions are advisory; preconditions are authoritative.

## Surface inventory

The following modules were inventoried for write tools:

| Module                    | Write tools?                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| `src/tools/mail.ts`       | Yes (4)                                                                   |
| `src/tools/calendar.ts`   | Yes (3)                                                                   |
| `src/tools/teams.ts`      | Yes (6)                                                                   |
| `src/tools/files.ts`      | No (read-only)                                                            |
| `src/tools/sharepoint.ts` | No (read-only)                                                            |
| `src/tools/users.ts`      | No (read-only)                                                            |
| `src/tools/identity.ts`   | No (read-only)                                                            |
| `src/tools/utility.ts`    | No (read-only — `parse-teams-url` is local; `download-bytes` is GET-only) |

Total write tools audited: **13**.

---

## Mail writes (already covered by #9-derived work, shipped in v2.1.0)

These are documented for completeness; no new issues filed.

### `create-draft-email`

- **Tool description**: "Create a draft email in the signed-in user's Drafts folder. Returns the new message including its id. The draft sits in Drafts until the human opens Outlook and clicks Send — this server has no send capability."
- **Graph endpoint**: `POST /me/messages`
- **Required scope**: `Mail.ReadWrite`
- **Graph layer accepts**: any draft Message payload in the caller's mailbox. `Mail.Send` is deliberately not in the Entra app's granted scopes, so the server has no way to send. There is no message-id to constrain at create time.
- **No gap**: the endpoint creates a new resource in the user's own mailbox; the `Mail.Send` exclusion at the Entra layer means the draft can't leave the Drafts folder without human action in Outlook. Recipient-allowlist guardrails for a future send capability are tracked separately.
- **Tracked in**: [#9](https://github.com/aretecp/ms-365-mcp-server/issues/9) (future send-capability guardrails — not a gap in the current draft-only posture).

### `update-mail-message`

- **Tool description**: "Update fields on a draft mail message by id. ... The server refuses this call if the message is not a draft (isDraft=true)."
- **Graph endpoint**: `PATCH /me/messages/{message-id}`
- **Required scope**: `Mail.ReadWrite`
- **Graph layer accepts**: PATCH against **any** message id in the mailbox — drafts, received mail, sent mail.
- **Gap (closed)**: without a guard, the LLM could PATCH a received message (e.g. mark as read, recategorize, edit categories) or mutate sent mail.
- **Guard shipped**: `assertIsDraft` precondition — `GET /me/messages/{id}?$select=isDraft` and refuse unless `isDraft === true`.
- **Tracked in**: shipped in v2.1.0 (commit `3574526`). No further work needed.

### `add-mail-attachment`

- **Tool description**: "Add an attachment to a draft message. ... The server refuses this call if the message is not a draft."
- **Graph endpoint**: `POST /me/messages/{message-id}/attachments`
- **Required scope**: `Mail.ReadWrite`
- **Graph layer accepts**: POST attachment against any message id in the mailbox.
- **Gap (closed)**: without a guard, the LLM could attach files to received or sent mail.
- **Guard shipped**: same `assertIsDraft` precondition.
- **Tracked in**: shipped in v2.1.0 (commit `3574526`).

### `delete-mail-message`

- **Tool description**: "Move a draft mail message to Deleted Items by id. The server refuses this call if the message is not a draft — received and sent mail must be actioned by the human in Outlook (the LLM cannot mass-delete an inbox via this tool)."
- **Graph endpoint**: `DELETE /me/messages/{message-id}`
- **Required scope**: `Mail.ReadWrite`
- **Graph layer accepts**: DELETE any message id in the mailbox.
- **Gap (closed)**: without a guard, the LLM could mass-delete received mail.
- **Guard shipped**: same `assertIsDraft` precondition.
- **Tracked in**: shipped in v2.1.0 (commit `3574526`).

---

## Calendar writes

### `create-calendar-event`

- **Tool description**: "Create a calendar event on the signed-in user's default calendar. Returns the created event including its id. Requires subject, start, and end at minimum."
- **Graph endpoint**: `POST /me/events`
- **Required scope**: `Calendars.ReadWrite`
- **Graph layer accepts**: any new event on the caller's default calendar; attendees are notified by email/Teams if invited.
- **No gap**: the endpoint creates a fresh resource on the caller's own calendar; there is no pre-existing id to constrain. Recipient-allowlist concerns for attendee emails are part of the broader send-guardrail discussion in #9 (out of scope here).

### `update-calendar-event`

- **Tool description**: "Update fields on an existing calendar event by id. Any field omitted is left unchanged. ... The server refuses this call if the signed-in user is not the organizer (isOrganizer=true) — accepted/declined invites must be managed by the human in Outlook."
- **Graph endpoint**: `PATCH /me/events/{event-id}`
- **Required scope**: `Calendars.ReadWrite`
- **Graph layer accepts**: PATCH against any event the user can see on their calendar — including events the user merely attends. On an attendee-side event, the PATCH mutates the user's local copy; the organizer is not notified.
- **Gap (closed)**: without a guard, the LLM could silently mutate the local copy of an event organized by someone else, surfacing as drift from the organizer's master copy.
- **Guard shipped**: `assertIsOrganizer` precondition — `GET /me/events/{id}?$select=isOrganizer` and refuse unless `isOrganizer === true`.
- **Tracked in**: [#10](https://github.com/aretecp/ms-365-mcp-server/issues/10) — shipped in commit `8fa98e8` (landed during the audit). No duplicate issue filed.

### `delete-calendar-event`

- **Tool description**: "Delete a calendar event by id. ... The server refuses this call if the signed-in user is not the organizer (isOrganizer=true) — the LLM cannot decline invites or mass-clear the calendar through this tool."
- **Graph endpoint**: `DELETE /me/events/{event-id}`
- **Required scope**: `Calendars.ReadWrite`
- **Graph layer accepts**: DELETE on any event in the user's calendar. On an attendee-side event, DELETE is equivalent to declining the invite — the event leaves the user's calendar but persists for the organizer and other attendees.
- **Gap (closed)**: without a guard, the LLM could decline arbitrary invites or clear the user's calendar of meetings organized by others.
- **Guard shipped**: same `assertIsOrganizer` precondition.
- **Tracked in**: [#10](https://github.com/aretecp/ms-365-mcp-server/issues/10) — shipped in commit `8fa98e8`.

---

## Teams writes

### `send-chat-message`

- **Tool description**: "Send a new message to a chat. Returns the created message including its id. Pair with list-chats to find the chat-id."
- **Graph endpoint**: `POST /chats/{chat-id}/messages`
- **Required scope**: `ChatMessage.Send`
- **Graph layer accepts**: posts to **any chat the signed-in user is a member of** — oneOnOne, group, or meeting chat. Crucially, this includes chats hosted in **other tenants** where the user participates as a guest, and federated / external-access chats. The `chat.tenantId` field can differ from the user's home tenant for cross-tenant scenarios. ([Send message in a chat](https://learn.microsoft.com/en-us/graph/api/chat-post-messages), [chat resource](https://learn.microsoft.com/en-us/graph/api/resources/chat))
- **Tool description claims**: posting to "a chat" the user has identified through `list-chats`. The description is silent on which chats; the model could reasonably read this as "any chat the user is a member of."
- **Gap**: a model that follows a noisy retrieval (`list-chats` returning many chats including meeting chats, guest/cross-tenant chats, or stale archived chats) could post messages to chats the user did not intend to participate in via the LLM. Specifically:
  - **Cross-tenant / guest chats**: posting LLM-authored content into a guest-tenant chat exposes content to participants outside the user's organization and may violate the host tenant's external-collaboration policy.
  - **Meeting chats (`chatType=meeting`)**: posts into a meeting chat are visible to everyone who attended that meeting, often a different audience than the user expects from "send a Teams message."
  - **Hidden chats** (`isHiddenForAllMembers=true`): the user can't see the chat in their Teams client but the tool can still post to it.
- **Proposed guard**: `assertChatIsPostable` precondition — `GET /chats/{chat-id}?$select=chatType,tenantId,isHiddenForAllMembers` and refuse if any of: `tenantId !== <user's home tenant>` (cross-tenant guest), `isHiddenForAllMembers === true`, or if a per-user policy allowlist of chat types is configured and `chatType` isn't in it. Refusal message: `"chat '{id}' is not a permissible posting target (chatType={chatType}, tenantId={tenantId}, hidden={isHiddenForAllMembers}). The signed-in user must be in a non-hidden, same-tenant chat for this tool to fire."`
- **Tracked in**: [#12](https://github.com/aretecp/ms-365-mcp-server/issues/12).

### `send-channel-message`

- **Tool description**: "Start a new thread in a channel by sending a top-level message. ... Set body.subject to give the thread a title."
- **Graph endpoint**: `POST /teams/{team-id}/channels/{channel-id}/messages`
- **Required scope**: `ChannelMessage.Send`
- **Graph layer accepts**: posts to **any channel the user is a member of**, including private channels, shared channels (which can include members from other tenants), and any channel the user has been added to as a guest. ([Send chatMessage in a channel](https://learn.microsoft.com/en-us/graph/api/channel-post-messages))
- **Tool description claims**: posting a top-level message into "a channel." The description does not narrow which channels.
- **Gap**: a channel write fans out to every member of the channel — potentially dozens of people across tenants for a shared channel. Posting LLM-authored content into a shared channel that includes external-tenant members may leak content cross-org. Worse, the model has no signal that a given channel is shared vs. standard.
- **Proposed guard**: `assertChannelIsStandardAndInternal` precondition — `GET /teams/{team-id}/channels/{channel-id}?$select=membershipType` and refuse unless `membershipType === 'standard'` (i.e. not `private` or `shared`). Optionally also enforce a per-user policy allowlist of `{team-id, channel-id}` tuples for channels the LLM is permitted to post in. Refusal message: `"channel '{channel-id}' in team '{team-id}' is not a permissible posting target (membershipType={membershipType}). Standard channels only; shared and private channels require explicit operator approval."`
- **Tracked in**: [#13](https://github.com/aretecp/ms-365-mcp-server/issues/13).

### `send-channel-message-reply`

- **Tool description**: "Add a reply to an existing channel thread. Use list-channel-messages to find the thread root id."
- **Graph endpoint**: `POST /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies`
- **Required scope**: `ChannelMessage.Send`
- **Graph layer accepts**: same as `send-channel-message` (any channel the user is a member of), against any thread root in that channel. There is no Graph-side check that the reply target is a "reasonable" thread — the model could reply to a thread it itself started moments ago, looping.
- **Tool description claims**: replying to "an existing channel thread."
- **Gap (compound)**: inherits the cross-tenant / shared-channel gap from `send-channel-message`, AND has a secondary failure mode: nothing prevents the model from replying to its own previous reply, creating a degenerate thread or a loop if combined with a retrieval-augmented agent.
- **Proposed guard**: same `assertChannelIsStandardAndInternal` precondition as `send-channel-message` (primary gap). The loop-prevention concern is better addressed by an agent-side guardrail (don't pass the bot's own message id as the reply target) than a server-side precondition — flagged as uncertain in the issue.
- **Tracked in**: [#13](https://github.com/aretecp/ms-365-mcp-server/issues/13) (combined with `send-channel-message` since the gap and fix are the same shape).

### `create-online-meeting`

- **Tool description**: "Create a Teams online meeting. Returns the meeting including its joinWebUrl. Does NOT add the meeting to the calendar."
- **Graph endpoint**: `POST /me/onlineMeetings`
- **Required scope**: `OnlineMeetings.ReadWrite`
- **Graph layer accepts**: creates a meeting owned by the signed-in user. The signed-in user is always the organizer; `participants.organizer` can't be set to a different user on the delegated `/me/onlineMeetings` endpoint. ([Create onlineMeeting](https://learn.microsoft.com/en-us/graph/api/application-post-onlinemeetings))
- **No gap**: the endpoint creates a fresh resource owned by the caller. There is no pre-existing id to constrain, and Graph forbids reassigning the organizer post-create. The `participants.attendees` field is in scope of the future recipient-allowlist work (#9) but is not a precondition-shaped gap.

### `update-online-meeting`

- **Tool description**: "Update fields on a Teams online meeting by id. Omitted fields are left unchanged."
- **Graph endpoint**: `PATCH /me/onlineMeetings/{meeting-id}`
- **Required scope**: `OnlineMeetings.ReadWrite`
- **Graph layer accepts**: PATCH on a meeting **the signed-in user organized**. The `/me/onlineMeetings/{meeting-id}` route is naturally scoped — the meeting id is resolved relative to the signed-in user as the organizer. Attendees who aren't the organizer cannot retrieve or modify a meeting via `/me/onlineMeetings/{id}`; Graph returns 404 for ids that don't correspond to a meeting the user organized. ([Update onlineMeeting](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-update))
- **No gap**: Graph's natural scoping of `/me/onlineMeetings/{id}` to organizer-owned meetings covers the description's claim. No precondition required.
- **Tracked in**: none — closed by Graph natural scoping.

### `delete-online-meeting`

- **Tool description**: "Delete a Teams online meeting by id. The meeting becomes inaccessible to attendees; if there is a corresponding calendar event, delete it separately with delete-calendar-event."
- **Graph endpoint**: `DELETE /me/onlineMeetings/{meeting-id}`
- **Required scope**: `OnlineMeetings.ReadWrite`
- **Graph layer accepts**: DELETE on a meeting the signed-in user organized. Same natural scoping as PATCH above — the `/me/onlineMeetings/{id}` route does not resolve to meetings the user merely attended. ([Delete onlineMeeting](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-delete))
- **No gap**: Graph's natural scoping covers the description's claim. No precondition required.
- **Tracked in**: none — closed by Graph natural scoping.

---

## Summary

| Tool                         | Status                                          | Tracked in                                                                        |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `create-draft-email`         | No gap (creates new)                            | —                                                                                 |
| `update-mail-message`        | Closed (`assertIsDraft`)                        | shipped v2.1.0                                                                    |
| `add-mail-attachment`        | Closed (`assertIsDraft`)                        | shipped v2.1.0                                                                    |
| `delete-mail-message`        | Closed (`assertIsDraft`)                        | shipped v2.1.0                                                                    |
| `create-calendar-event`      | No gap (creates new)                            | —                                                                                 |
| `update-calendar-event`      | Closed (`assertIsOrganizer`)                    | [#10](https://github.com/aretecp/ms-365-mcp-server/issues/10) (shipped `8fa98e8`) |
| `delete-calendar-event`      | Closed (`assertIsOrganizer`)                    | [#10](https://github.com/aretecp/ms-365-mcp-server/issues/10) (shipped `8fa98e8`) |
| `send-chat-message`          | **Gap** (cross-tenant / hidden chats)           | [#12](https://github.com/aretecp/ms-365-mcp-server/issues/12)                     |
| `send-channel-message`       | **Gap** (private/shared channels)               | [#13](https://github.com/aretecp/ms-365-mcp-server/issues/13)                     |
| `send-channel-message-reply` | **Gap** (inherited from `send-channel-message`) | [#13](https://github.com/aretecp/ms-365-mcp-server/issues/13)                     |
| `create-online-meeting`      | No gap (creates new)                            | —                                                                                 |
| `update-online-meeting`      | No gap (Graph natural scoping)                  | —                                                                                 |
| `delete-online-meeting`      | No gap (Graph natural scoping)                  | —                                                                                 |

Two new gap-tracking issues filed: **#12** (chat target scoping) and **#13** (channel target scoping). Mail and calendar gaps are tracked in pre-existing tickets.

## Uncertainty notes

- The Microsoft Graph docs for `/me/onlineMeetings/{id}` PATCH/DELETE describe organizer-only semantics implicitly (via the "organizer can't be modified after create" note and the unique-per-organizer meeting-id format) but do not state a hard "attendees cannot call this endpoint" rule. Empirically, attendees do not have ids that resolve through `/me/onlineMeetings/`; the meeting id is bound to the organizer's record. We assess this as "no gap" but if Microsoft ever broadens that route's resolution (e.g. exposes attended meetings under `/me/onlineMeetings`), the conclusion would need revisiting.
- The proposed `tenantId` check on chats relies on comparing `chat.tenantId` to the signed-in user's home tenant. Resolving the signed-in user's home tenant from the access token (the `tid` claim) is straightforward but adds a lookup; an alternative implementation could store it on the request context. Either is fine; the issue body leaves the implementation choice to the implementer.
- `send-channel-message-reply` loop prevention is acknowledged as an agent-design concern rather than a server-side one; the filed issue records this honestly rather than mandating a precondition for it.
