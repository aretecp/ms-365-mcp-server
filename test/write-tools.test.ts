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
    'send-draft-message',
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
    expect(scopes).toContain('Mail.Send');
    expect(scopes).toContain('Calendars.ReadWrite');
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

  beforeEach(() => {
    vi.clearAllMocks();
    graphRequest = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockGraphClient = { graphRequest } as unknown as GraphClient;
  });

  it('create-draft-email POSTs a JSON body to /me/messages', async () => {
    const tool = findTool('create-draft-email');
    await executeTool(tool, mockGraphClient, {
      body: {
        subject: 'Hello',
        body: { contentType: 'text', content: 'Test body' },
        toRecipients: [{ emailAddress: { address: 'to@example.com' } }],
      },
    });

    const [calledPath, options] = graphRequest.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(calledPath).toBe('/me/messages');
    expect(options.method).toBe('POST');
    const parsed = JSON.parse(options.body);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.toRecipients[0].emailAddress.address).toBe('to@example.com');
  });

  it('update-mail-message PATCHes the message id with a JSON body', async () => {
    const tool = findTool('update-mail-message');
    await executeTool(tool, mockGraphClient, {
      'message-id': 'msg-1',
      body: { isRead: true },
    });

    const [calledPath, options] = graphRequest.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(calledPath).toBe('/me/messages/msg-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ isRead: true });
  });

  it('send-draft-message POSTs to the /send sub-resource with no body', async () => {
    const tool = findTool('send-draft-message');
    await executeTool(tool, mockGraphClient, { 'message-id': 'msg-2' });

    const [calledPath, options] = graphRequest.mock.calls[0] as [
      string,
      { method: string; body?: string },
    ];
    expect(calledPath).toBe('/me/messages/msg-2/send');
    expect(options.method).toBe('POST');
    expect(options.body).toBeUndefined();
  });

  it('delete-mail-message DELETEs the message resource', async () => {
    const tool = findTool('delete-mail-message');
    await executeTool(tool, mockGraphClient, { 'message-id': 'msg-3' });

    const [calledPath, options] = graphRequest.mock.calls[0] as [string, { method: string }];
    expect(calledPath).toBe('/me/messages/msg-3');
    expect(options.method).toBe('DELETE');
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
    const [calledPath, options] = graphRequest.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(calledPath).toBe('/me/events');
    expect(options.method).toBe('POST');
    const parsed = JSON.parse(options.body);
    expect(parsed.subject).toBe('Sync');
    expect(parsed.start.timeZone).toBe('America/New_York');
  });
});

describe('policy gating on write tools', () => {
  const writes = ['create-draft-email', 'send-draft-message', 'create-calendar-event'];

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
