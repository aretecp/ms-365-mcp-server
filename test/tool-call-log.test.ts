import { describe, expect, it, beforeEach } from 'vitest';
import {
  ToolCallLog,
  redactArgs,
  redactResponse,
  toolCallLog,
  type ToolCallEntry,
} from '../src/admin/tool-call-log.ts';

function makeEntry(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    id: 'test-id',
    ts: Date.now(),
    upn: 'user@example.com',
    toolName: 'get-me',
    status: 'allowed',
    latencyMs: 10,
    argsExcerpt: '{}',
    responseExcerpt: '{"id":"me"}',
    errorText: null,
    ...overrides,
  };
}

describe('ToolCallLog — ring buffer', () => {
  it('records entries and returns them newest-first', () => {
    const log = new ToolCallLog(10);
    log.record(makeEntry({ toolName: 'first', ts: 1000 }));
    log.record(makeEntry({ toolName: 'second', ts: 2000 }));
    log.record(makeEntry({ toolName: 'third', ts: 3000 }));

    const snap = log.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap[0].toolName).toBe('third');
    expect(snap[1].toolName).toBe('second');
    expect(snap[2].toolName).toBe('first');
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const log = new ToolCallLog(3);
    log.record(makeEntry({ toolName: 'a', ts: 1 }));
    log.record(makeEntry({ toolName: 'b', ts: 2 }));
    log.record(makeEntry({ toolName: 'c', ts: 3 }));
    // capacity+1 insertion should evict 'a'
    log.record(makeEntry({ toolName: 'd', ts: 4 }));

    const snap = log.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap.map((e) => e.toolName)).toEqual(['d', 'c', 'b']);
    expect(snap.find((e) => e.toolName === 'a')).toBeUndefined();
  });

  it('snapshot returns a copy — mutations do not affect the buffer', () => {
    const log = new ToolCallLog(10);
    log.record(makeEntry({ toolName: 'original' }));

    const snap = log.snapshot();
    snap[0] = makeEntry({ toolName: 'mutated' });

    const snap2 = log.snapshot();
    expect(snap2[0].toolName).toBe('original');
  });

  it('clear() empties the buffer', () => {
    const log = new ToolCallLog(10);
    log.record(makeEntry());
    log.record(makeEntry());
    log.clear();

    expect(log.snapshot()).toHaveLength(0);
    expect(log.size).toBe(0);
  });

  it('size reflects current entry count up to capacity', () => {
    const log = new ToolCallLog(5);
    expect(log.size).toBe(0);
    log.record(makeEntry());
    expect(log.size).toBe(1);
    for (let i = 0; i < 10; i++) log.record(makeEntry());
    expect(log.size).toBe(5);
  });
});

describe('redactArgs', () => {
  it('passes through a plain object', () => {
    const result = redactArgs({ user: 'alice', count: 3 });
    expect(result).toBe('{"user":"alice","count":3}');
  });

  it('strips keys matching password', () => {
    const result = redactArgs({ username: 'alice', password: 'hunter2' });
    expect(result).toContain('"password":"[REDACTED]"');
    expect(result).toContain('"username":"alice"');
  });

  it('strips keys matching secret', () => {
    const result = redactArgs({ clientSecret: 'abc123', name: 'app' });
    expect(result).toContain('"clientSecret":"[REDACTED]"');
    expect(result).not.toContain('abc123');
  });

  it('strips keys matching token', () => {
    const result = redactArgs({ access_token: 'tok123', scopes: 'read' });
    expect(result).toContain('"access_token":"[REDACTED]"');
    expect(result).not.toContain('tok123');
  });

  it('strips keys matching authorization (case-insensitive)', () => {
    const result = redactArgs({ Authorization: 'Bearer xyz', body: 'hi' });
    expect(result).toContain('"Authorization":"[REDACTED]"');
    expect(result).not.toContain('xyz');
  });

  it('truncates long stringified values to 512 chars + ellipsis', () => {
    const bigVal = 'x'.repeat(600);
    const result = redactArgs({ data: bigVal });
    expect(result.length).toBeLessThanOrEqual(516); // 512 + '…' (3 bytes UTF-8) + some JSON overhead
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles non-object inputs gracefully', () => {
    expect(redactArgs('hello')).toBe('"hello"');
    expect(redactArgs(42)).toBe('42');
    expect(redactArgs(null)).toBe('null');
    expect(redactArgs(undefined)).toBe('');
  });

  it('handles arrays without key stripping', () => {
    const result = redactArgs(['a', 'b']);
    expect(result).toBe('["a","b"]');
  });
});

describe('redactResponse', () => {
  it('returns null for null/undefined input', () => {
    expect(redactResponse(null)).toBeNull();
    expect(redactResponse(undefined)).toBeNull();
  });

  it('passes through short text unchanged', () => {
    const text = '{"id":"me","displayName":"Alice"}';
    expect(redactResponse(text)).toBe(text);
  });

  it('truncates text longer than 512 chars', () => {
    const long = 'a'.repeat(600);
    const result = redactResponse(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(516);
    expect(result!.endsWith('…')).toBe(true);
  });

  it('does not strip keys — just truncates', () => {
    const text = '{"password":"hunter2"}';
    expect(redactResponse(text)).toBe(text);
  });
});

describe('module-level toolCallLog singleton', () => {
  beforeEach(() => {
    toolCallLog.clear();
  });

  it('is a ToolCallLog instance', () => {
    expect(toolCallLog).toBeInstanceOf(ToolCallLog);
  });

  it('starts empty after clear()', () => {
    expect(toolCallLog.size).toBe(0);
  });

  it('records entries and returns them via snapshot()', () => {
    toolCallLog.record(makeEntry({ toolName: 'get-me' }));
    const snap = toolCallLog.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].toolName).toBe('get-me');
  });
});
