/**
 * Unit 6 — static toolset tags + deployment-time registration filter.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import GraphClient from '../src/graph-client.js';
import { registerTools, type RegisterToolsOptions } from '../src/tool-runtime.js';
import { CORE_TOOL_NAMES } from '../src/toolset-config.js';
import { Policy } from '../src/policy/index.js';
import logger from '../src/logger.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function registeredNames(opts?: RegisterToolsOptions): string[] {
  const calls: string[] = [];
  const mockServer = { tool: vi.fn((name: string) => calls.push(name)) };
  const gc = { graphRequest: vi.fn() } as unknown as GraphClient;
  registerTools(mockServer as never, gc, opts);
  return calls;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => delete process.env.MS365_MCP_TOOLSETS);

describe('toolset registration filter', () => {
  it('default (core only) registers the core set + utilities and defers the long tail', () => {
    const names = registeredNames();
    for (const c of CORE_TOOL_NAMES) expect(names, `missing core ${c}`).toContain(c);
    expect(names).toContain('download-bytes');
    expect(names).toContain('parse-teams-url');
    // Deferred long tail is absent by default.
    expect(names).not.toContain('list-sites');
    expect(names).not.toContain('list-chats');
    expect(names).not.toContain('create-draft-email');
  });

  it("enabling a single toolset registers that domain (and leaves others off)", () => {
    const names = registeredNames({ toolsets: new Set(['sharepoint']) });
    expect(names).toContain('list-sites');
    expect(names).toContain('sharepoint-drive-children-list');
    expect(names).not.toContain('list-chats'); // teams still off
    // core still present
    expect(names).toContain('mail-message-list');
  });

  it("'all' registers everything including writes", () => {
    const names = registeredNames({ toolsets: 'all' });
    expect(names).toContain('list-chats');
    expect(names).toContain('create-calendar-event');
    expect(names).toContain('list-sites');
  });

  it('reads the enabled domains from MS365_MCP_TOOLSETS', () => {
    process.env.MS365_MCP_TOOLSETS = 'teams';
    const names = registeredNames();
    expect(names).toContain('list-chats');
    expect(names).not.toContain('list-sites');
  });

  it('warns when policy allows a tool that is not registered', () => {
    const policy = Policy.fromDocument({ defaults: { allow: ['list-chats', 'get-me'] } });
    registeredNames({ policy }); // core only → list-chats not registered
    expect(logger.warn as Mock).toHaveBeenCalledWith(expect.stringContaining("'list-chats'"));
  });
});
