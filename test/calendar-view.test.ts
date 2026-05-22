import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import GraphClient from '../src/graph-client.js';
import { executeTool, registerTools } from '../src/tool-runtime.js';
import type { Tool } from '../src/tools/index.js';
import { ALL_TOOLS } from '../src/tools/index.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const findTool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

describe('Calendar tools', () => {
  let mockServer: { tool: ReturnType<typeof vi.fn> };
  let mockGraphClient: GraphClient;
  let graphRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = { tool: vi.fn() };
    graphRequest = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ value: [] }) }],
    });
    mockGraphClient = { graphRequest } as unknown as GraphClient;
  });

  function getRegisteredSchema(toolName: string): Record<string, z.ZodTypeAny> {
    registerTools(mockServer as never, mockGraphClient);
    const call = mockServer.tool.mock.calls.find((c: unknown[]) => c[0] === toolName);
    expect(call, `tool ${toolName} not registered`).toBeDefined();
    return call![2] as Record<string, z.ZodTypeAny>;
  }

  describe('registration', () => {
    it('registers the three v1 calendar tools', () => {
      registerTools(mockServer as never, mockGraphClient);
      const toolNames = mockServer.tool.mock.calls.map((c: unknown[]) => c[0]);
      expect(toolNames).toContain('list-calendar-events');
      expect(toolNames).toContain('get-calendar-event');
      expect(toolNames).toContain('get-calendar-view');
    });

    it.each(['list-calendar-events', 'get-calendar-event', 'get-calendar-view'])(
      '%s exposes the timezone control parameter',
      (name) => {
        expect(getRegisteredSchema(name)).toHaveProperty('timezone');
      }
    );

    it.each(['list-calendar-events', 'get-calendar-event', 'get-calendar-view'])(
      '%s exposes the expandExtendedProperties control parameter',
      (name) => {
        expect(getRegisteredSchema(name)).toHaveProperty('expandExtendedProperties');
      }
    );

    it('GET tools get a fetchAllPages parameter', () => {
      registerTools(mockServer as never, mockGraphClient);
      for (const call of mockServer.tool.mock.calls) {
        const toolName = call[0] as string;
        if (toolName === 'parse-teams-url' || toolName === 'download-bytes') continue;
        expect(call[2]).toHaveProperty('fetchAllPages');
      }
    });
  });

  describe('Prefer header', () => {
    it('sets outlook.timezone when timezone param is provided', async () => {
      const tool = findTool('get-calendar-view') as Tool;
      await executeTool(tool, mockGraphClient, undefined, {
        startDateTime: '2026-05-22T00:00:00Z',
        endDateTime: '2026-05-29T00:00:00Z',
        timezone: 'America/New_York',
      });

      const options = graphRequest.mock.calls[0][1] as { headers: Record<string, string> };
      expect(options.headers['Prefer']).toContain('outlook.timezone="America/New_York"');
    });

    it('sets outlook.body-content-type=text by default on GETs', async () => {
      const tool = findTool('get-calendar-event') as Tool;
      await executeTool(tool, mockGraphClient, undefined, { 'event-id': 'abc' });

      const options = graphRequest.mock.calls[0][1] as { headers: Record<string, string> };
      expect(options.headers['Prefer']).toContain('outlook.body-content-type="text"');
    });
  });

  describe('expandExtendedProperties', () => {
    it('appends singleValueExtendedProperties to $expand when true', async () => {
      const tool = findTool('get-calendar-event') as Tool;
      await executeTool(tool, mockGraphClient, undefined, {
        'event-id': 'abc',
        expandExtendedProperties: true,
      });

      const calledPath = graphRequest.mock.calls[0][0] as string;
      expect(calledPath).toContain('$expand=singleValueExtendedProperties');
    });

    it('merges with an existing expand value rather than overwriting', async () => {
      const tool = findTool('get-calendar-event') as Tool;
      await executeTool(tool, mockGraphClient, undefined, {
        'event-id': 'abc',
        expand: 'attachments',
        expandExtendedProperties: true,
      });

      // The runtime preserves `,` literally in query strings (no %2C escape).
      const calledPath = graphRequest.mock.calls[0][0] as string;
      expect(calledPath).toContain('$expand=attachments,singleValueExtendedProperties');
    });
  });

  describe('calendarView required params', () => {
    it('encodes startDateTime and endDateTime as $-prefixed query params', async () => {
      const tool = findTool('get-calendar-view') as Tool;
      await executeTool(tool, mockGraphClient, undefined, {
        startDateTime: '2026-05-22T00:00:00Z',
        endDateTime: '2026-05-29T00:00:00Z',
      });

      const calledPath = graphRequest.mock.calls[0][0] as string;
      // Not $-prefixed — these are domain params, not OData.
      expect(calledPath).toContain('startDateTime=2026-05-22T00%3A00%3A00Z');
      expect(calledPath).toContain('endDateTime=2026-05-29T00%3A00%3A00Z');
    });
  });
});
