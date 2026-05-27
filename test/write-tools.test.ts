import { beforeEach, describe, expect, it, vi } from 'vitest';
import GraphClient from '../src/graph-client.js';
import { executeTool, registerTools } from '../src/tool-runtime.js';
import { ALL_TOOLS, type Tool } from '../src/tools/index.js';
import { resolveAuthScopes } from '../src/oauth/scopes.js';
import { Policy } from '../src/policy/index.js';
import { requestContext } from '../src/request-context.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const findTool = (name: string) => ALL_TOOLS.find((t) => t.name === name) as Tool;

describe('write-tool registration', () => {
  const writeNames = [
    'create-draft-email',
    'update-mail-message',
    'add-mail-attachment',
    'delete-mail-message',
    'create-calendar-event',
    'update-calendar-event',
    'delete-calendar-event',
  ];

  it('every PR 4 write tool is in ALL_TOOLS', () => {
    for (const name of writeNames) expect(findTool(name)).toBeDefined();
  });

  it('write-tool scopes are exposed via OAuth scopes_supported', () => {
    const scopes = resolveAuthScopes();
    expect(scopes).toContain('Mail.ReadWrite');
    expect(scopes).toContain('Calendars.ReadWrite');
  });

  it('Mail.Send is NOT requested — drafts only, human sends from Outlook', () => {
    const scopes = resolveAuthScopes();
    expect(scopes).not.toContain('Mail.Send');
    expect(ALL_TOOLS.find((t) => t.name === 'send-draft-message')).toBeUndefined();
  });

  it('non-GET write tools surface destructiveHint via the McpServer registration', () => {
    const calls: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [];
    const mockServer = {
      tool: vi.fn((name: string, description: string, schema, hints) => {
        calls.push([name, description, schema, hints]);
      }),
    };
    const graphClient = { graphRequest: vi.fn() } as unknown as GraphClient;
    registerTools(mockServer as never, graphClient);

    for (const name of writeNames) {
      const call = calls.find((c) => c[0] === name);
      expect(call, `tool ${name} not registered`).toBeDefined();
      const hints = call![3] as { readOnlyHint: boolean; destructiveHint: boolean };
      expect(hints.readOnlyHint).toBe(false);
      expect(hints.destructiveHint).toBe(true);
    }
  });
});

describe('write-tool runtime', () => {
  let mockGraphClient: GraphClient;
  let graphRequest: ReturnType<typeof vi.fn>;

  // Mail write tools (other than create-draft-email) carry an isDraft
  // precondition; calendar update/delete tools carry an isOrganizer
  // precondition. The runtime issues a GET ?$select=<prop> before the main
  // call; default the mock to "yes it's a draft" / "yes you're the organizer"
  // so existing test bodies exercise the main code path. Negative cases
  // override per-test.
  beforeEach(() => {
    vi.clearAllMocks();
    graphRequest = vi.fn().mockImplementation((path: string) => {
      if (path.includes('$select=isDraft')) {
        return Promise.resolve({ isDraft: true });
      }
      if (path.includes('$select=isOrganizer')) {
        return Promise.resolve({ isOrganizer: true });
      }
      return Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    });
    mockGraphClient = { graphRequest } as unknown as GraphClient;
  });

  // Helper: the main Graph call is whichever one isn't a precondition probe.
  const mainCall = () =>
    graphRequest.mock.calls.find(
      ([p]: [string]) => !p.includes('$select=isDraft') && !p.includes('$select=isOrganizer')
    ) as [string, { method: string; body?: string }] | undefined;

  it('create-draft-email POSTs a JSON body to /me/messages', async () => {
    const tool = findTool('create-draft-email');
    await executeTool(tool, mockGraphClient, {
      body: {
        subject: 'Hello',
        body: { contentType: 'text', content: 'Test body' },
        toRecipients: [{ emailAddress: { address: 'to@example.com' } }],
      },
    });

    // create-draft-email has no precondition — only one call.
    expect(graphRequest.mock.calls).toHaveLength(1);
    const call = mainCall()!;
    expect(call[0]).toBe('/me/messages');
    expect(call[1].method).toBe('POST');
    const parsed = JSON.parse(call[1].body!);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.toRecipients[0].emailAddress.address).toBe('to@example.com');
  });

  it('update-mail-message PATCHes the message id after isDraft check passes', async () => {
    const tool = findTool('update-mail-message');
    await executeTool(tool, mockGraphClient, {
      'message-id': 'msg-1',
      body: { isRead: true },
    });

    // First call: precondition probe. Second call: the PATCH.
    expect(graphRequest.mock.calls[0][0]).toBe('/me/messages/msg-1?$select=isDraft');
    expect(graphRequest.mock.calls[0][1].method).toBe('GET');

    const call = mainCall()!;
    expect(call[0]).toBe('/me/messages/msg-1');
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body!)).toEqual({ isRead: true });
  });

  it('delete-mail-message DELETEs after isDraft check passes', async () => {
    const tool = findTool('delete-mail-message');
    await executeTool(tool, mockGraphClient, { 'message-id': 'msg-3' });

    expect(graphRequest.mock.calls[0][0]).toBe('/me/messages/msg-3?$select=isDraft');
    const call = mainCall()!;
    expect(call[0]).toBe('/me/messages/msg-3');
    expect(call[1].method).toBe('DELETE');
  });

  // ---- Precondition: negative cases ----
  // The runtime must refuse non-draft writes regardless of tool description.

  for (const toolName of ['update-mail-message', 'delete-mail-message', 'add-mail-attachment']) {
    it(`${toolName} REFUSES when isDraft=false (received mail) and never fires the main call`, async () => {
      graphRequest = vi.fn().mockResolvedValue({ isDraft: false });
      mockGraphClient = { graphRequest } as unknown as GraphClient;

      const params: Record<string, unknown> = { 'message-id': 'received-msg' };
      if (toolName === 'update-mail-message') params.body = { isRead: true };
      if (toolName === 'add-mail-attachment') {
        params.body = { '@odata.type': '#microsoft.graph.fileAttachment', name: 'x' };
      }

      const result = await executeTool(findTool(toolName), mockGraphClient, params);

      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.error).toMatch(/precondition failed/i);
      expect(payload.error).toMatch(/not a draft/i);
      // Exactly one Graph call — the isDraft probe — and nothing else.
      expect(graphRequest.mock.calls).toHaveLength(1);
      expect(graphRequest.mock.calls[0][0]).toContain('$select=isDraft');
    });
  }

  it('update-mail-message REFUSES when the message does not exist (precondition GET fails)', async () => {
    graphRequest = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    mockGraphClient = { graphRequest } as unknown as GraphClient;

    const result = await executeTool(findTool('update-mail-message'), mockGraphClient, {
      'message-id': 'gone',
      body: { isRead: true },
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.error).toMatch(/could not verify message is a draft/i);
    // Only the failed probe ran — no PATCH attempted.
    expect(graphRequest.mock.calls).toHaveLength(1);
  });

  it('create-calendar-event POSTs the event body to /me/events', async () => {
    const tool = findTool('create-calendar-event');
    await executeTool(tool, mockGraphClient, {
      body: {
        subject: 'Sync',
        start: { dateTime: '2026-05-22T14:00:00', timeZone: 'America/New_York' },
        end: { dateTime: '2026-05-22T15:00:00', timeZone: 'America/New_York' },
      },
    });

    // create-calendar-event has no precondition — only one call.
    expect(graphRequest.mock.calls).toHaveLength(1);
    const call = mainCall()!;
    expect(call[0]).toBe('/me/events');
    expect(call[1].method).toBe('POST');
    const parsed = JSON.parse(call[1].body!);
    expect(parsed.subject).toBe('Sync');
    expect(parsed.start.timeZone).toBe('America/New_York');
  });

  it('update-calendar-event PATCHes the event id after isOrganizer check passes', async () => {
    const tool = findTool('update-calendar-event');
    await executeTool(tool, mockGraphClient, {
      'event-id': 'evt-1',
      body: { subject: 'Renamed' },
    });

    // First call: precondition probe. Second call: the PATCH.
    expect(graphRequest.mock.calls[0][0]).toBe('/me/events/evt-1?$select=isOrganizer');
    expect(graphRequest.mock.calls[0][1].method).toBe('GET');

    const call = mainCall()!;
    expect(call[0]).toBe('/me/events/evt-1');
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body!)).toEqual({ subject: 'Renamed' });
  });

  it('delete-calendar-event DELETEs after isOrganizer check passes', async () => {
    const tool = findTool('delete-calendar-event');
    await executeTool(tool, mockGraphClient, { 'event-id': 'evt-2' });

    expect(graphRequest.mock.calls[0][0]).toBe('/me/events/evt-2?$select=isOrganizer');
    const call = mainCall()!;
    expect(call[0]).toBe('/me/events/evt-2');
    expect(call[1].method).toBe('DELETE');
  });

  // ---- Precondition: calendar negative cases ----
  // Attendee-side events (isOrganizer=false) and nonexistent events must be
  // refused before any PATCH/DELETE fires.

  for (const toolName of ['update-calendar-event', 'delete-calendar-event']) {
    it(`${toolName} REFUSES when isOrganizer=false (attendee event) and never fires the main call`, async () => {
      graphRequest = vi.fn().mockResolvedValue({ isOrganizer: false });
      mockGraphClient = { graphRequest } as unknown as GraphClient;

      const params: Record<string, unknown> = { 'event-id': 'invite-evt' };
      if (toolName === 'update-calendar-event') params.body = { subject: 'nope' };

      const result = await executeTool(findTool(toolName), mockGraphClient, params);

      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.error).toMatch(/precondition failed/i);
      expect(payload.error).toMatch(/not organized by the signed-in user/i);
      // Exactly one Graph call — the isOrganizer probe — and nothing else.
      expect(graphRequest.mock.calls).toHaveLength(1);
      expect(graphRequest.mock.calls[0][0]).toContain('$select=isOrganizer');
    });

    it(`${toolName} REFUSES when the event does not exist (precondition GET fails)`, async () => {
      graphRequest = vi.fn().mockRejectedValue(new Error('404 Not Found'));
      mockGraphClient = { graphRequest } as unknown as GraphClient;

      const params: Record<string, unknown> = { 'event-id': 'gone' };
      if (toolName === 'update-calendar-event') params.body = { subject: 'nope' };

      const result = await executeTool(findTool(toolName), mockGraphClient, params);

      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.error).toMatch(/could not verify event is organized/i);
      // Only the failed probe ran — no PATCH/DELETE attempted.
      expect(graphRequest.mock.calls).toHaveLength(1);
    });
  }
});

describe('policy gating on write tools', () => {
  const writes = ['create-draft-email', 'update-mail-message', 'create-calendar-event'];

  function makePolicy(extra?: Record<string, { allow?: string[]; deny?: string[] }>) {
    return Policy.fromDocument({
      defaults: { allow: ['get-me'] },
      users: extra,
    });
  }

  function makeMockGraphClient() {
    const graphRequest = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    return { graphRequest } as unknown as GraphClient;
  }

  it('a user not in the policy is denied every write tool', async () => {
    const policy = makePolicy();
    const mockGraphClient = makeMockGraphClient();

    for (const name of writes) {
      const result = await requestContext.run(
        {
          accessToken: 'at',
          userOid: 'oid',
          tenantId: 't',
          userPrincipalName: 'random@example.com',
        },
        () =>
          executeTool(
            findTool(name),
            mockGraphClient,
            // Schema-valid stubs so we exercise the gate, not validation.
            {
              body: {
                subject: 'x',
                start: { dateTime: '2026-05-22T00:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-05-22T01:00:00', timeZone: 'UTC' },
              },
              'message-id': 'm',
            },
            policy
          )
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Policy denied');
    }
    // No Graph request should have fired for any of them.
    expect(
      (mockGraphClient as unknown as { graphRequest: ReturnType<typeof vi.fn> }).graphRequest
    ).not.toHaveBeenCalled();
  });

  it('a user with an explicit allow entry passes through to the Graph call', async () => {
    const policy = makePolicy({
      'operator@example.com': { allow: writes },
    });
    const mockGraphClient = makeMockGraphClient();

    await requestContext.run(
      {
        accessToken: 'at',
        userOid: 'oid',
        tenantId: 't',
        userPrincipalName: 'operator@example.com',
      },
      () =>
        executeTool(
          findTool('create-draft-email'),
          mockGraphClient,
          { body: { subject: 'allowed' } },
          policy
        )
    );

    expect(
      (mockGraphClient as unknown as { graphRequest: ReturnType<typeof vi.fn> }).graphRequest
    ).toHaveBeenCalledTimes(1);
  });

  it('user.deny wins over user.allow even when defaults would have allowed', async () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['delete-mail-message'] },
      users: {
        'careful@example.com': {
          allow: ['delete-mail-message'],
          deny: ['delete-mail-message'],
        },
      },
    });
    const mockGraphClient = makeMockGraphClient();

    const result = await requestContext.run(
      {
        accessToken: 'at',
        userOid: 'oid',
        tenantId: 't',
        userPrincipalName: 'careful@example.com',
      },
      () =>
        executeTool(findTool('delete-mail-message'), mockGraphClient, { 'message-id': 'm' }, policy)
    );
    expect(result.isError).toBe(true);
    expect(
      (mockGraphClient as unknown as { graphRequest: ReturnType<typeof vi.fn> }).graphRequest
    ).not.toHaveBeenCalled();
  });
});
