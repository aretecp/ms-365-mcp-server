import { z } from 'zod';
import { OData, type Tool } from './types.js';

export const calendarTools: readonly Tool[] = [
  {
    name: 'list-calendar-events',
    description:
      "List the signed-in user's calendar events (not expanded; recurring events show as the series master). For an expanded window over a date range, use get-calendar-view instead.",
    method: 'GET',
    path: '/me/events',
    scopes: ['Calendars.Read'],
    supportsTimezone: true,
    supportsExpandExtendedProperties: true,
    params: [
      OData.filter,
      OData.search,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
      OData.count,
      OData.expand,
    ],
  },
  {
    name: 'get-calendar-event',
    description: 'Get a single calendar event by id.',
    method: 'GET',
    path: '/me/events/{event-id}',
    scopes: ['Calendars.Read'],
    supportsTimezone: true,
    supportsExpandExtendedProperties: true,
    params: [
      {
        name: 'event-id',
        location: 'path',
        schema: z.string().describe('Calendar event id'),
      },
      OData.select,
      OData.expand,
    ],
  },
  {
    name: 'get-calendar-view',
    description:
      "Expanded calendar view between two times. Recurring events are expanded into individual occurrences over the window — usually what an LLM actually wants when asked 'what's on the calendar this week'.",
    method: 'GET',
    path: '/me/calendarView',
    scopes: ['Calendars.Read'],
    supportsTimezone: true,
    supportsExpandExtendedProperties: true,
    params: [
      {
        name: 'startDateTime',
        location: 'query',
        schema: z.string().describe('ISO 8601 start of the window, e.g. 2026-05-22T00:00:00Z'),
      },
      {
        name: 'endDateTime',
        location: 'query',
        schema: z.string().describe('ISO 8601 end of the window, e.g. 2026-05-29T00:00:00Z'),
      },
      OData.filter,
      OData.select,
      OData.orderby,
      OData.top,
      OData.skip,
      OData.expand,
    ],
  },
];
