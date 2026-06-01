# Areté Microsoft 365 MCP Server

Self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Microsoft Graph (Outlook mail, Outlook calendar, OneDrive, SharePoint, Teams) to Areté's LLM agents over a single multi-tenant-aware HTTP endpoint.

Originally forked from [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) and rewritten for our deployment model. Areté now owns this codebase; upstream is a reference, not a dependency.

## Status

Hand-written tool surface. Currently exposing:

- **Mail**: read + draft + delete (Outlook). **No send** — see [Why no Mail.Send](#why-no-mailsend).
- **Calendar**: read + create + update + delete events.
- **Files (OneDrive)**: read-only.
- **SharePoint**: sites, document libraries, lists — read-only.
- **Teams**: chats, channels (read + send), online meetings (find + create + update + delete), transcripts (read).
- **Directory**: `identity-get-me`, `user-search`, `user-get`.
- **Utilities**: `download-bytes`, `parse-teams-url`.

Per-user OAuth sessions in SQLite. Per-user, per-tool policy in YAML with admin UI + SIGHUP reload. HTTP transport only.

## Requirements

- Node.js 24+
- An Entra ID app registration in your tenant (delegated permissions only). Several Teams scopes require admin consent — see **Entra app setup** below.

## Quick start (development)

```bash
# Set up secrets
cat > .env <<'EOF'
MS365_MCP_CLIENT_ID=<your Entra app client ID>
MS365_MCP_TENANT_ID=<your tenant ID>
# Optional confidential-client secret
MS365_MCP_CLIENT_SECRET=<secret if used>
MS365_MCP_SESSION_KEY=<openssl rand -base64 32>
MS365_MCP_POLICY_ADMINS=<your UPN>
EOF

cp policy/policy.yaml.example policy/policy.yaml

npm install
npm run dev:http   # binds 127.0.0.1:3000
```

## Entra app setup

Delegated permissions needed for the full v1.5 surface. **Bold scopes need admin consent** on the Entra app registration:

- `User.Read`, `offline_access` (silently injected)
- Mail: `Mail.Read`, `Mail.ReadWrite` (no `Mail.Send` — see [Why no Mail.Send](#why-no-mailsend))
- Calendar: `Calendars.Read`, `Calendars.ReadWrite`
- Files: `Files.Read`
- Directory: **`User.ReadBasic.All`**
- SharePoint: **`Sites.Read.All`**
- Teams chats: `Chat.ReadBasic`, `Chat.Read`, `ChatMessage.Send`
- Teams channels: **`Team.ReadBasic.All`**, **`Channel.ReadBasic.All`**, **`ChannelMessage.Read.All`**, **`ChannelMessage.Send`**
- Online meetings: `OnlineMeetings.Read`, `OnlineMeetings.ReadWrite`, **`OnlineMeetingTranscript.Read.All`**

After granting consent, users will see a single consent prompt on first sign-in covering everything they're authorized to use.

**Redirect URI — register exactly one.** The server brokers OAuth: Microsoft only ever redirects back to the server's own callback, never to the MCP client. Add this single redirect URI to the Entra app (Authentication → Web), using your public host:

```
https://<your-host>/auth/callback     # prod, e.g. https://m365.mcp.areteintelligence.ai/auth/callback
http://localhost:3000/auth/callback    # local dev
```

That one entry covers every MCP client. No per-client Entra changes are ever needed — clients obtain their own `client_id` through Dynamic Client Registration (see [Connecting a client](#connecting-a-client)).

## Connecting a client

Point any MCP client (Claude, MCP Inspector/Jam, Cursor, …) at `https://<your-host>/mcp` — that's it. The server is a self-contained OAuth authorization server, so the client auto-negotiates everything:

1. **Discovery** — `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`.
2. **Dynamic Client Registration** (RFC 7591) — the client POSTs its callback to `/register` and gets a `client_id`. No pre-registered credentials, no manual allowlisting.
3. **Authorize + token** — standard Authorization Code + PKCE against `/authorize` and `/token`.
4. The client then sends `Authorization: Bearer <session>` on `/mcp`.

Clients that don't perform DCR (Claude.ai today) keep working via the legacy `MS365_MCP_ALLOWED_REDIRECT_URIS` fallback.

### Why no Mail.Send

The server can draft, update, attach to, and delete mail (`Mail.ReadWrite`) — but cannot send. There is no `send-draft-message` tool, and `Mail.Send` is deliberately omitted from the Entra app's requested scopes. Drafts the LLM produces sit in the user's Drafts folder; the human reviews them in Outlook and clicks Send themselves.

This is structural human-in-the-loop. With both the tool absent and the scope ungranted, an unintended `messages/{id}/send` call would be refused by Microsoft Graph even if it bypassed our policy layer.

We may re-add send capability in a future release with guardrails — at minimum an approved-recipients / approved-domain allow-list enforced at the tool layer before any send call reaches Graph. Tracked in [issue #9](https://github.com/aretecp/ms-365-mcp-server/issues/9).

## Server-enforced invariants

> **Tool descriptions are not a security control.** The LLM can ignore them; well-meaning prompt-engineering papers over real authorization gaps. This server enforces critical invariants in code, in the runtime, before any outbound Graph call. If the description says "draft" and the LLM passes a non-draft id, the server refuses — independent of policy, independent of the model's intent.

Mechanism: `Tool.precondition` in `src/tools/types.ts`. Before executing a tool, the runtime in `src/tool-runtime.ts` invokes the precondition; a thrown error becomes a structured MCP error response and the main Graph call never fires.

Current preconditions:

| Tool                    | Invariant                             | Implementation                                                                           |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `mail-message-update`   | message must satisfy `isDraft=true`   | `assertIsDraft` — GET `/me/messages/{id}?$select=isDraft`, refuse if not a draft         |
| `mail-attachment-add`   | message must satisfy `isDraft=true`   | same                                                                                     |
| `mail-message-delete`   | message must satisfy `isDraft=true`   | same — model cannot mass-delete received mail                                            |
| `calendar-event-update` | event must satisfy `isOrganizer=true` | `assertIsOrganizer` — GET `/me/events/{id}?$select=isOrganizer`, refuse if not organizer |
| `calendar-event-delete` | event must satisfy `isOrganizer=true` | same                                                                                     |

`Mail.ReadWrite` at the Graph layer is broader than what we want to expose. Without `assertIsDraft`, the LLM could PATCH any message (mark as read, flag, recategorize), DELETE any message (clear an inbox), or attach files to received mail. The precondition closes that gap.

`Calendars.ReadWrite` has the same shape: it covers any event the signed-in user is an attendee of, not just events they organize. Without `assertIsOrganizer`, the LLM could PATCH an attendee-side event (silently mutating the user's local copy) or DELETE one (which Graph interprets as declining the invite). The precondition restricts both write paths to organizer-owned events; accepted/declined invites must be managed by the human in Outlook.

The full surface audit ran in [issue #11](https://github.com/aretecp/ms-365-mcp-server/issues/11) and lives in [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md). Remaining preconditions identified by the audit are tracked in [issue #12](https://github.com/aretecp/ms-365-mcp-server/issues/12) (`assertChatIsPostable` for `teams-chat-message-send`) and [issue #13](https://github.com/aretecp/ms-365-mcp-server/issues/13) (`assertChannelIsStandardAndInternal` for `teams-channel-message-send` + `teams-channel-message-reply-send`). Online-meeting writes and event/draft creation tools are closed by Graph natural scoping — no precondition needed.

## Production deployment

Documented in our internal infrastructure repo. The server expects:

- `MS365_MCP_CLIENT_ID`, `MS365_MCP_TENANT_ID`, `MS365_MCP_CLIENT_SECRET` (latter required for confidential-client setups).
- `MS365_MCP_PUBLIC_URL` (or `--public-url`) when running behind a reverse proxy. Browser-facing OAuth redirects (including the server's `/auth/callback`) use this; internal endpoints stay on the request origin.
- `MS365_MCP_ALLOWED_REDIRECT_URIS` — legacy redirect allowlist for clients that do **not** perform Dynamic Client Registration (e.g. Claude.ai). DCR clients are validated against their own registered `redirect_uris`, so new clients need no entry here. Optional.
- `MS365_MCP_CORS_ORIGIN` — optional. Leave unset for permissive CORS (reflects the caller's Origin) so any MCP client can connect; set to a single origin to pin it for a hardened deployment.

## CLI options

```
-v                 Verbose logging
--http [address]   Bind Streamable HTTP transport. Format: [host:]port (e.g. "3000", ":3000", "localhost:3000"). Default: all interfaces on port 3000.
--public-url <url> Public base URL (e.g. https://mcp.example.com) used in browser-facing OAuth redirects when behind a reverse proxy.
--toon             TOON output format. ~30-60% fewer tokens than JSON for uniform array data.
```

Environment variables:

- `MS365_MCP_CLIENT_ID`, `MS365_MCP_TENANT_ID`, `MS365_MCP_CLIENT_SECRET` — Entra app credentials.
- `MS365_MCP_PUBLIC_URL` — see above.
- `MS365_MCP_CORS_ORIGIN` — see above.
- `MS365_MCP_ALLOWED_REDIRECT_URIS` — see above.
- `MS365_MCP_OUTPUT_FORMAT=toon` — alternative to `--toon`.
- `MS365_MCP_MAX_TOP=<n>` — hard cap on Graph `$top` for list requests.
- `MS365_MCP_BODY_FORMAT=html` — return email bodies as HTML instead of plain text (default: text).
- `MS365_MCP_POLICY_PATH` — override the default `./policy/policy.yaml` location.
- `MS365_MCP_POLICY_ADMINS` — **required** comma-separated list of UPNs allowed to access the admin UI at `/admin/login`. Server refuses to start if empty.
- `LOG_LEVEL`, `SILENT`.

## Admin UI

Operators with a UPN listed in `MS365_MCP_POLICY_ADMINS` can manage `policy/policy.yaml` through a browser. Visit `https://<host>/admin/login`, complete the Microsoft sign-in, edit the YAML, save. The save is atomic and the live policy reloads in-process — no restart, signed-in MCP users keep their sessions.

For operators who prefer the CLI, edits to the file directly are picked up by sending **SIGHUP** to the server process:

```bash
kill -HUP $(pidof microsoft-mcp-server)
```

Failed reloads (bad YAML, validation error) are logged and the previously-loaded policy stays active — a typo never takes the server down.

## Output formats

JSON by default. Pass `--toon` (or `MS365_MCP_OUTPUT_FORMAT=toon`) for [Token-Oriented Object Notation](https://github.com/toon-format/toon) — 30-60% fewer tokens vs JSON, ideal for cost-sensitive batch workloads against uniform array data (lists of emails, events, files).

## Auth flow

OAuth Authorization Code + PKCE, **brokered**. The server is the OAuth client to Entra _and_ a self-contained OAuth authorization server to the MCP client. Microsoft only ever redirects to the server's own `/auth/callback`, so a single Entra redirect URI serves every client, and clients self-register via RFC 7591 DCR.

```
MCP client ──/register──> us  (gets client_id)
MCP client ──/authorize──> us ──MS authorize (our callback, server PKCE)──> Entra
Entra ──code──> us (/auth/callback) ──MS token exchange──> Entra ──tokens──> us
   us: create session, mint OUR auth code ──redirect to client callback──> MCP client
MCP client ──/token (our code + client PKCE verifier)──> us ──opaque session id──> MCP client
MCP client ──Bearer <session id>──> /mcp
```

Per-user sessions are SQLite-backed: the MCP client holds an opaque session id, while encrypted Microsoft refresh + access tokens stay server-side and are refreshed transparently on each call. PKCE is verified end-to-end — the brokered authorization code is useless without the client's verifier. Dynamically-registered clients live in the `oauth_clients` table (same DB file as sessions).

## Contributing

Internal Areté repository. Before opening a PR:

```bash
npm run verify
```

Runs lint, format check, build, and tests.

## License

MIT. See [LICENSE](./LICENSE).
