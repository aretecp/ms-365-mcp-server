/**
 * Unit 2a — per-tool path-resolver seam. A tool may compute its Graph path
 * from params (e.g. optional-id read merges); the consumed params are declared
 * in resolverParams and must not leak to the query string.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import GraphClient from '../src/graph-client.js';
import { executeTool } from '../src/tool-runtime.js';
import { OData, type Tool } from '../src/tools/index.js';
import logger from '../src/logger.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeGraphClient(): { gc: GraphClient; paths: () => string[] } {
  const graphRequest = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: '{"value":[]}' }],
    isError: false,
  });
  return {
    gc: { graphRequest } as unknown as GraphClient,
    paths: () => graphRequest.mock.calls.map((c) => String(c[0])),
  };
}

const resolverTool: Tool = {
  name: 'test-resolver',
  description: 'test',
  method: 'GET',
  path: '/should-not-be-used',
  scopes: [],
  params: [OData.select, OData.top],
  resolverParams: ['folder-id'],
  pathResolver: (p) =>
    p['folder-id']
      ? `/me/mailFolders/${encodeURIComponent(String(p['folder-id']))}/messages`
      : '/me/messages',
};

beforeEach(() => vi.clearAllMocks());

describe('pathResolver', () => {
  it('selects the no-id path shape when the resolver param is absent', async () => {
    const { gc, paths } = makeGraphClient();
    await executeTool(resolverTool, gc, {});
    expect(paths()[0]).toMatch(/^\/me\/messages/);
    expect(paths()[0]).not.toContain('/should-not-be-used');
  });

  it('selects the id path shape when the resolver param is present', async () => {
    const { gc, paths } = makeGraphClient();
    await executeTool(resolverTool, gc, { 'folder-id': 'F1' });
    expect(paths()[0]).toMatch(/^\/me\/mailFolders\/F1\/messages/);
  });

  it('does not leak a resolver-consumed param onto the query string', async () => {
    const { gc, paths } = makeGraphClient();
    await executeTool(resolverTool, gc, { 'folder-id': 'F1', select: 'id' });
    const path = paths()[0];
    expect(path).not.toContain('folder-id');
    expect(path).toContain('$select=id');
  });

  it('warns when a resolver leaves an unsubstituted placeholder', async () => {
    const { gc } = makeGraphClient();
    const broken: Tool = {
      ...resolverTool,
      name: 'broken-resolver',
      pathResolver: () => '/me/items/{item-id}/children',
    };
    await executeTool(broken, gc, {});
    expect(logger.warn as Mock).toHaveBeenCalledWith(
      expect.stringContaining('unsubstituted path placeholder {item-id}')
    );
  });

  it('leaves a tool without a resolver on its static path (no regression)', async () => {
    const { gc, paths } = makeGraphClient();
    const staticTool: Tool = {
      name: 'static',
      description: 'x',
      method: 'GET',
      path: '/me/drive/root',
      scopes: [],
      params: [],
    };
    await executeTool(staticTool, gc, {});
    expect(paths()[0]).toBe('/me/drive/root');
  });
});
