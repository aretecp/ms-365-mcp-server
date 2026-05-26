import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { generateCsrfToken, verifyCsrfToken } from '../src/admin/csrf.ts';

describe('admin CSRF tokens', () => {
  const originalKey = process.env.MS365_MCP_SESSION_KEY;

  beforeEach(() => {
    process.env.MS365_MCP_SESSION_KEY = crypto.randomBytes(32).toString('base64');
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MS365_MCP_SESSION_KEY;
    else process.env.MS365_MCP_SESSION_KEY = originalKey;
  });

  it('verifies a token generated for the same sessionId', () => {
    const token = generateCsrfToken('session-abc');
    expect(verifyCsrfToken('session-abc', token)).toBe(true);
  });

  it('rejects a token generated for a different sessionId', () => {
    const token = generateCsrfToken('session-abc');
    expect(verifyCsrfToken('session-xyz', token)).toBe(false);
  });

  it('rejects a malformed token without throwing', () => {
    expect(verifyCsrfToken('session-abc', 'not-hex')).toBe(false);
    expect(verifyCsrfToken('session-abc', '')).toBe(false);
    expect(verifyCsrfToken('session-abc', undefined)).toBe(false);
  });

  it('rejects a token of the wrong length even if it is valid hex', () => {
    expect(verifyCsrfToken('session-abc', 'deadbeef')).toBe(false);
  });

  it('rejects all tokens when MS365_MCP_SESSION_KEY is missing', () => {
    delete process.env.MS365_MCP_SESSION_KEY;
    // verify path catches the underlying loadKey throw and returns false.
    expect(verifyCsrfToken('session-abc', 'a'.repeat(64))).toBe(false);
  });
});
