/**
 * Exercises contacts cursor pagination through the REAL GraphClient — both
 * JSON and TOON output modes must work end-to-end (TOON is the configured
 * format in both docker-compose.prod.yml and docker-compose.dev.yml, so a
 * refusal would make these tools unusable as actually deployed). `_etag`
 * (includeHeaders) and `excludeResponse` are asserted through the real
 * serializer/formatter, not a hand-rolled mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { decode as toonDecode } from '@toon-format/toon';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/cloud-config.js', () => ({
  getCloudEndpoints: () => ({
    graphApi: 'https://graph.microsoft.com',
    authority: 'https://login.microsoftonline.com',
  }),
}));

// Dynamic import (not static): vi.mock('../src/cloud-config.js') above must
// apply before graph-client.js is evaluated, so these modules — and
// everything they transitively pull in — load only after the mock is
// registered (mirrors the established pattern in test/odata-nextlink.test.ts).
const { default: GraphClient } = await import('../src/graph-client.js');
const { executeTool } = await import('../src/tool-runtime.js');
const { ALL_TOOLS } = await import('../src/tools/index.js');
const { requestContext } = await import('../src/request-context.js');

const findTool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MS365_MCP_SESSION_KEY = crypto.randomBytes(32).toString('base64');
});
afterEach(() => {
  delete process.env.MS365_MCP_SESSION_KEY;
  delete process.env.MS365_MCP_MAX_RESPONSE_CHARS;
});

function ctx() {
  return {
    accessToken: 'at',
    userOid: 'oid-1',
    tenantId: 't',
    userPrincipalName: 'user@example.com',
  };
}

/** Decodes a tool response body in whichever format the GraphClient was configured for. */
function decodeBody(text: string, format: 'json' | 'toon'): Record<string, unknown> {
  return (format === 'toon' ? toonDecode(text) : JSON.parse(text)) as Record<string, unknown>;
}

/** Request-aware fetch stub: derives each Graph page from the actual requested $skip/$top. */
function installRequestAwareFetch(dataset: { id: string }[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const skip = Number(url.searchParams.get('$skip') ?? '0');
    const top = Number(url.searchParams.get('$top') ?? '100');
    const page = dataset.slice(skip, skip + top);
    const body: Record<string, unknown> = { value: page };
    if (skip + top < dataset.length) {
      body['@odata.nextLink'] =
        `https://graph.microsoft.com/v1.0${url.pathname.slice('/v1.0'.length)}?$top=${top}&$skip=${skip + top}`;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe.each(['json', 'toon'] as const)('contact-list pagination in %s output mode', (format) => {
  it('walks 3,500 uniquely-identified contacts to hasMore=false with exact coverage and no duplicates', async () => {
    const dataset = Array.from({ length: 3500 }, (_, i) => ({ id: `contact-${i}` }));
    const mockFetch = installRequestAwareFetch(dataset);
    const gc = new GraphClient(format);

    const seen = new Set<string>();
    let cursor: string | undefined;
    let call = 0;
    const maxCalls = 100;
    while (call < maxCalls) {
      call++;
      const params = cursor ? { cursor } : { top: 100 };
      const result = await requestContext.run(ctx(), () =>
        executeTool(findTool('contact-list'), gc, params)
      );
      expect(result.isError, `call ${call} should not error`).toBeFalsy();
      const body = decodeBody(result.content[0].text, format);
      const value = body.value as { id: string }[];
      for (const item of value) {
        expect(seen.has(item.id), `duplicate id ${item.id} at call ${call}`).toBe(false);
        seen.add(item.id);
      }
      if (!body.hasMore) break;
      cursor = body.cursor as string;
      expect(typeof cursor).toBe('string');
    }

    expect(call).toBeLessThan(maxCalls);
    expect(seen.size).toBe(3500);
    for (let i = 0; i < 3500; i++) expect(seen.has(`contact-${i}`)).toBe(true);
    mockFetch.mockRestore();
  }, 20_000);

  it('enforces the response-size ceiling on the ACTUAL serialized envelope in this format (truncates rather than returning everything)', async () => {
    const dataset = Array.from({ length: 200 }, (_, i) => ({
      id: `contact-${i}`,
      displayName: 'x'.repeat(20),
    }));
    const mockFetch = installRequestAwareFetch(dataset);
    const gc = new GraphClient(format);
    process.env.MS365_MCP_MAX_RESPONSE_CHARS = '1500';

    const result = await requestContext.run(ctx(), () =>
      executeTool(findTool('contact-list'), gc, { top: 200 })
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.length).toBeLessThanOrEqual(1500);
    const body = decodeBody(result.content[0].text, format);
    const value = body.value as { id: string }[];
    expect(value.length).toBeLessThan(200);
    expect(body.truncated).toBe(true);
    expect(body.hasMore).toBe(true);
    expect(typeof body.cursor).toBe('string');
    mockFetch.mockRestore();
  });

  it('preserves _etag (includeHeaders) through the real formatter', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ value: [{ id: '1', displayName: 'Alex Wilber' }] }), {
        status: 200,
        headers: { ETag: 'W/"abc123"', 'Content-Type': 'application/json' },
      })
    );
    const gc = new GraphClient(format);
    const result = await requestContext.run(ctx(), () =>
      executeTool(findTool('contact-list'), gc, { includeHeaders: true })
    );
    expect(result.isError).toBeFalsy();
    const body = decodeBody(result.content[0].text, format);
    expect(body._etag).toBe('W/"abc123"');
    expect((body.value as unknown[]).length).toBe(1);
    expect(body.hasMore).toBe(false);
    mockFetch.mockRestore();
  });

  it('excludeResponse returns the plain success envelope untouched, no pagination fields added', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ value: [{ id: '1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const gc = new GraphClient(format);
    const result = await requestContext.run(ctx(), () =>
      executeTool(findTool('contact-list'), gc, { excludeResponse: true })
    );
    expect(result.isError).toBeFalsy();
    const body = decodeBody(result.content[0].text, format);
    expect(body).toEqual({ success: true });
    mockFetch.mockRestore();
  });
});
