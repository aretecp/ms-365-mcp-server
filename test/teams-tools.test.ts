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

const READ_NAMES = [
  'list-chats',
  'get-chat',
  'list-chat-messages',
  'get-chat-message',
  'list-joined-teams',
  'list-team-channels',
  'list-channel-messages',
  'get-channel-message',
  'list-channel-message-replies',
  'online-meeting-find',
  'list-meeting-transcripts',
];

const WRITE_NAMES = [
  'send-chat-message',
  'send-channel-message',
  'send-channel-message-reply',
  'create-online-meeting',
  'update-online-meeting',
  'delete-online-meeting',
];

describe('Teams-tool registration', () => {
  it('all Teams tools are present in ALL_TOOLS', () => {
    for (const name of [...READ_NAMES, ...WRITE_NAMES]) {
      expect(findTool(name), `missing ${name}`).toBeDefined();
    }
  });

  it('exposes the expected Teams scopes via OAuth scopes_supported', () => {
    const scopes = resolveAuthScopes();
    // Reads
    expect(scopes).toContain('Chat.ReadBasic');
    expect(scopes).toContain('Chat.Read');
    expect(scopes).toContain('Team.ReadBasic.All');
    expect(scopes).toContain('Channel.ReadBasic.All');
    expect(scopes).toContain('ChannelMessage.Read.All');
    expect(scopes).toContain('OnlineMeetings.Read');
    expect(scopes).toContain('OnlineMeetingTranscript.Read.All');
    // Writes
    expect(scopes).toContain('ChatMessage.Send');
    expect(scopes).toContain('ChannelMessage.Send');
    expect(scopes).toContain('OnlineMeetings.ReadWrite');
  });

  it('marks reads readOnly and writes destructive on registration', () => {
    const calls: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [];
    const mockServer = {
      tool: vi.fn((name: string, description: string, schema, hints) => {
        calls.push([name, description, schema, hints]);
      }),
    };
    const graphClient = { graphRequest: vi.fn() } as unknown as GraphClient;
    registerTools(mockServer as never, graphClient, { toolsets: 'all' });

    for (const name of READ_NAMES) {
      const call = calls.find((c) => c[0] === name);
      expect(call, `${name} not registered`).toBeDefined();
      const hints = call![3] as { readOnlyHint: boolean; destructiveHint: boolean };
      expect(hints.readOnlyHint).toBe(true);
      expect(hints.destructiveHint).toBe(false);
    }
    for (const name of WRITE_NAMES) {
      const call = calls.find((c) => c[0] === name);
      expect(call, `${name} not registered`).toBeDefined();
      const hints = call![3] as { readOnlyHint: boolean; destructiveHint: boolean };
      expect(hints.readOnlyHint).toBe(false);
      expect(hints.destructiveHint).toBe(true);
    }
  });
});

describe('Teams-tool runtime — representative reads', () => {
  let mockGraphClient: GraphClient;
  let graphRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    graphRequest = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockGraphClient = { graphRequest } as unknown as GraphClient;
  });

  it('list-chats GETs /me/chats', async () => {
    await executeTool(findTool('list-chats'), mockGraphClient, {});
    const [path, opts] = graphRequest.mock.calls[0] as [string, { method: string }];
    expect(path.startsWith('/me/chats')).toBe(true);
    expect(opts.method).toBe('GET');
  });

  it('list-chat-messages substitutes the chat-id into the path', async () => {
    await executeTool(findTool('list-chat-messages'), mockGraphClient, {
      'chat-id': '19:abc@thread.v2',
    });
    const path = graphRequest.mock.calls[0][0] as string;
    // `:` is percent-encoded; the runtime preserves `=` but not `:`.
    expect(path).toContain('/chats/19%3Aabc%40thread.v2/messages');
  });

  it('online-meeting-find by join-web-url builds the $filter server-side', async () => {
    const joinUrl = 'https://teams.microsoft.com/l/meetup-join/abc';
    await executeTool(findTool('online-meeting-find'), mockGraphClient, { 'join-web-url': joinUrl });
    const path = graphRequest.mock.calls[0][0] as string;
    expect(path).toContain('/me/onlineMeetings?$filter=');
    expect(path).toContain('joinWebUrl');
    // Spaces become %20; the model never hand-writes OData (the runtime builds it).
    expect(path).toContain('%20eq%20');
  });

  it('online-meeting-find by meeting-id GETs the meeting path', async () => {
    await executeTool(findTool('online-meeting-find'), mockGraphClient, { 'meeting-id': 'MMM' });
    expect(graphRequest.mock.calls[0][0] as string).toMatch(/^\/me\/onlineMeetings\/MMM/);
  });

  it('online-meeting-find refuses neither / both lookup keys (precondition)', async () => {
    const neither = await executeTool(findTool('online-meeting-find'), mockGraphClient, {});
    expect(neither.isError).toBe(true);
    const both = await executeTool(findTool('online-meeting-find'), mockGraphClient, {
      'meeting-id': 'a',
      'join-web-url': 'b',
    });
    expect(both.isError).toBe(true);
  });

  it('list-channel-message-replies threads team / channel / message ids into the path', async () => {
    await executeTool(findTool('list-channel-message-replies'), mockGraphClient, {
      'team-id': 'team-1',
      'channel-id': 'chan-1',
      'chatMessage-id': 'msg-1',
    });
    const path = graphRequest.mock.calls[0][0] as string;
    expect(path).toContain('/teams/team-1/channels/chan-1/messages/msg-1/replies');
  });
});

describe('Teams-tool runtime — writes', () => {
  let mockGraphClient: GraphClient;
  let graphRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    graphRequest = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockGraphClient = { graphRequest } as unknown as GraphClient;
  });

  it('send-chat-message POSTs a chatMessage JSON body to the chat', async () => {
    await executeTool(findTool('send-chat-message'), mockGraphClient, {
      'chat-id': 'chat-1',
      body: {
        body: { contentType: 'html', content: '<p>hi</p>' },
      },
    });
    const [path, opts] = graphRequest.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/chats/chat-1/messages');
    expect(opts.method).toBe('POST');
    const parsed = JSON.parse(opts.body);
    expect(parsed.body.contentType).toBe('html');
    expect(parsed.body.content).toBe('<p>hi</p>');
  });

  it('send-channel-message-reply POSTs to the /replies sub-resource', async () => {
    await executeTool(findTool('send-channel-message-reply'), mockGraphClient, {
      'team-id': 't',
      'channel-id': 'c',
      'chatMessage-id': 'm',
      body: { body: { contentType: 'html', content: '<p>reply</p>' } },
    });
    const [path, opts] = graphRequest.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/teams/t/channels/c/messages/m/replies');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).body.content).toBe('<p>reply</p>');
  });

  it('create-online-meeting POSTs the meeting body to /me/onlineMeetings', async () => {
    await executeTool(findTool('create-online-meeting'), mockGraphClient, {
      body: {
        subject: 'Sync',
        startDateTime: '2026-05-23T14:00:00Z',
        endDateTime: '2026-05-23T15:00:00Z',
      },
    });
    const [path, opts] = graphRequest.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/me/onlineMeetings');
    expect(opts.method).toBe('POST');
    const parsed = JSON.parse(opts.body);
    expect(parsed.subject).toBe('Sync');
    expect(parsed.startDateTime).toBe('2026-05-23T14:00:00Z');
  });

  it('update-online-meeting PATCHes the meeting id', async () => {
    await executeTool(findTool('update-online-meeting'), mockGraphClient, {
      'meeting-id': 'meet-1',
      body: { subject: 'Renamed' },
    });
    const [path, opts] = graphRequest.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/me/onlineMeetings/meet-1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body).subject).toBe('Renamed');
  });

  it('delete-online-meeting DELETEs the meeting', async () => {
    await executeTool(findTool('delete-online-meeting'), mockGraphClient, {
      'meeting-id': 'meet-1',
    });
    const [path, opts] = graphRequest.mock.calls[0] as [string, { method: string }];
    expect(path).toBe('/me/onlineMeetings/meet-1');
    expect(opts.method).toBe('DELETE');
  });
});

describe('Teams-tool policy gating', () => {
  function makeMockGraphClient() {
    const graphRequest = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    return { graphRequest } as unknown as GraphClient;
  }

  const defaultsAllowingReads = ['list-chats', 'list-joined-teams', 'online-meeting-find'];

  it('reads in defaults.allow let a user with no per-user entry through', async () => {
    const policy = Policy.fromDocument({ defaults: { allow: defaultsAllowingReads } });
    const mockGraphClient = makeMockGraphClient();

    await requestContext.run(
      {
        accessToken: 'at',
        userOid: 'oid',
        tenantId: 't',
        userPrincipalName: 'random@example.com',
      },
      () => executeTool(findTool('list-chats'), mockGraphClient, {}, policy)
    );

    expect(
      (mockGraphClient as unknown as { graphRequest: ReturnType<typeof vi.fn> }).graphRequest
    ).toHaveBeenCalledTimes(1);
  });

  it('writes are denied for a user with no per-user allow entry', async () => {
    const policy = Policy.fromDocument({ defaults: { allow: defaultsAllowingReads } });
    const mockGraphClient = makeMockGraphClient();

    for (const name of WRITE_NAMES) {
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
            {
              'chat-id': 'c',
              'team-id': 't',
              'channel-id': 'ch',
              'chatMessage-id': 'm',
              'meeting-id': 'meet',
              body: {
                body: { contentType: 'html', content: 'x' },
                subject: 'x',
                startDateTime: '2026-05-23T00:00:00Z',
                endDateTime: '2026-05-23T01:00:00Z',
              },
            },
            policy
          )
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Policy denied');
    }
    expect(
      (mockGraphClient as unknown as { graphRequest: ReturnType<typeof vi.fn> }).graphRequest
    ).not.toHaveBeenCalled();
  });

  it('a user with users.<upn>.allow for a write tool passes through', async () => {
    const policy = Policy.fromDocument({
      defaults: { allow: defaultsAllowingReads },
      users: {
        'operator@example.com': { allow: ['send-chat-message'] },
      },
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
          findTool('send-chat-message'),
          mockGraphClient,
          {
            'chat-id': 'c',
            body: { body: { contentType: 'html', content: 'hi' } },
          },
          policy
        )
    );

    expect(
      (mockGraphClient as unknown as { graphRequest: ReturnType<typeof vi.fn> }).graphRequest
    ).toHaveBeenCalledTimes(1);
  });
});
