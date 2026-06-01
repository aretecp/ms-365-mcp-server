/**
 * Unit 1 — server-side response shaping: the hard response-size ceiling and
 * the marked truncation envelope. Drives executeTool with an oversized JSON
 * list payload and asserts the result is a valid, marked, continuable envelope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GraphClient from '../src/graph-client.js';
import { executeTool } from '../src/tool-runtime.js';
import { ALL_TOOLS, type Tool } from '../src/tools/index.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const findTool = (name: string) => ALL_TOOLS.find((t) => t.name === name) as Tool;

function makeGraphClient(responseText: string): GraphClient {
  return {
    graphRequest: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      isError: false,
    }),
  } as unknown as GraphClient;
}

function bigListPayload(n: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    value: Array.from({ length: n }, (_, i) => ({ id: String(i), subject: 'x'.repeat(60) })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MS365_MCP_MAX_RESPONSE_CHARS = '400';
});
afterEach(() => delete process.env.MS365_MCP_MAX_RESPONSE_CHARS);

describe('response-size ceiling', () => {
  it('truncates an over-budget list and emits a valid marked envelope', async () => {
    const gc = makeGraphClient(bigListPayload(50));
    const result = await executeTool(findTool('mail-message-list'), gc, {});

    const body = JSON.parse(result.content[0].text);
    expect(body.truncated).toBe(true);
    expect(Array.isArray(body.value)).toBe(true);
    expect(body.value.length).toBeLessThan(50);
    expect(body.value.length).toBe(body.returnedCount);
    expect(body.totalCount).toBe(50);
    expect(typeof body.hint).toBe('string');
  });

  it('leaves an under-budget response untouched (no envelope)', async () => {
    const gc = makeGraphClient(bigListPayload(1));
    const result = await executeTool(findTool('mail-message-list'), gc, {});

    const body = JSON.parse(result.content[0].text);
    expect(body.truncated).toBeUndefined();
    expect(body.value).toHaveLength(1);
  });

  it('includes an opaque nextCursor when the page had an @odata.nextLink', async () => {
    const gc = makeGraphClient(
      bigListPayload(50, {
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=50',
      })
    );
    const result = await executeTool(findTool('mail-message-list'), gc, {});

    const body = JSON.parse(result.content[0].text);
    expect(body.truncated).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
    expect(body.nextCursor.length).toBeGreaterThan(0);
    expect(body.hint).toContain('nextCursor');
  });

  it('does not reshape a non-collection JSON response over the ceiling', async () => {
    const blob = JSON.stringify({ id: 'x', note: 'y'.repeat(1000) });
    const gc = makeGraphClient(blob);
    const result = await executeTool(findTool('mail-message-get'), gc, { 'message-id': 'abc' });

    const body = JSON.parse(result.content[0].text);
    expect(body.truncated).toBeUndefined();
    expect(body.note).toHaveLength(1000);
  });
});
