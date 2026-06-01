/**
 * Unit 6 — static toolset tags + deployment-time registration filter.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import GraphClient from '../src/graph-client.js';
import { registerTools, type RegisterToolsOptions } from '../src/tool-runtime.js';
import { CORE_TOOL_NAMES } from '../src/toolset-config.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import { Policy } from '../src/policy/index.js';
import logger from '../src/logger.js';
import fs from 'node:fs';
import yaml from 'js-yaml';

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
    expect(names).not.toContain('sharepoint-site-list');
    expect(names).not.toContain('teams-chat-list');
    expect(names).not.toContain('mail-draft-create');
  });

  it('every CORE_TOOL_NAME is a real tool in ALL_TOOLS (guards rename drift)', () => {
    const all = new Set(ALL_TOOLS.map((t) => t.name));
    for (const c of CORE_TOOL_NAMES) {
      expect(all, `stale core tool name: ${c}`).toContain(c);
    }
  });

  it('enabling a single toolset registers that domain (and leaves others off)', () => {
    const names = registeredNames({ toolsets: new Set(['sharepoint']) });
    expect(names).toContain('sharepoint-site-list');
    expect(names).toContain('sharepoint-drive-children-list');
    expect(names).not.toContain('teams-chat-list'); // teams still off
    // core still present
    expect(names).toContain('mail-message-list');
  });

  it("'all' registers everything including writes", () => {
    const names = registeredNames({ toolsets: 'all' });
    expect(names).toContain('teams-chat-list');
    expect(names).toContain('calendar-event-create');
    expect(names).toContain('sharepoint-site-list');
  });

  it('reads the enabled domains from MS365_MCP_TOOLSETS', () => {
    process.env.MS365_MCP_TOOLSETS = 'teams';
    const names = registeredNames();
    expect(names).toContain('teams-chat-list');
    expect(names).not.toContain('sharepoint-site-list');
  });

  it('warns when policy allows a tool that is not registered', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['teams-chat-list', 'identity-get-me'] },
    });
    registeredNames({ policy }); // core only → teams-chat-list not registered
    expect(logger.warn as Mock).toHaveBeenCalledWith(expect.stringContaining("'teams-chat-list'"));
  });
});

describe('policy.yaml.example name consistency (U2b)', () => {
  it('every defaults.allow tool resolves to a registered tool (catches stale/renamed names)', () => {
    const doc = yaml.load(fs.readFileSync('policy/policy.yaml.example', 'utf8')) as {
      defaults?: { allow?: string[] };
    };
    const allowed = doc.defaults?.allow ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    const registered = new Set(registeredNames({ toolsets: 'all' }));
    for (const name of allowed) {
      expect(
        registered,
        `policy.yaml.example lists '${name}' which is not a registered tool`
      ).toContain(name);
    }
  });
});
