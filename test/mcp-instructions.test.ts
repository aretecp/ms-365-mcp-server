import { describe, expect, it } from 'vitest';
import { buildMcpServerInstructions } from '../src/mcp-instructions.js';

describe('buildMcpServerInstructions', () => {
  it('includes general Graph guidance', () => {
    const s = buildMcpServerInstructions({ multiAccount: false });
    expect(s).toContain('Microsoft Graph');
    expect(s).toContain('$filter');
  });

  it('does not suggest account switching when multiAccount is false', () => {
    const s = buildMcpServerInstructions({ multiAccount: false });
    expect(s).not.toContain('Multiple accounts');
    expect(s).not.toContain('account parameter');
  });

  it('mentions the account parameter when multiAccount is true', () => {
    const s = buildMcpServerInstructions({ multiAccount: true });
    expect(s).toContain('Multiple accounts');
    expect(s).toContain('account');
  });

  it('omits Teams guidance by default (core-only session)', () => {
    const s = buildMcpServerInstructions({ multiAccount: false });
    expect(s).not.toContain('Teams chat and channel');
    // core/general guidance is still present
    expect(s).toContain('Microsoft Graph');
    expect(s).toContain('KQL');
  });

  it('includes Teams guidance when the teams toolset is enabled', () => {
    const s = buildMcpServerInstructions({ multiAccount: false, toolsets: new Set(['teams']) });
    expect(s).toContain('Teams chat and channel');
  });

  it('includes Teams guidance when all toolsets are enabled', () => {
    const s = buildMcpServerInstructions({ multiAccount: false, toolsets: 'all' });
    expect(s).toContain('Teams chat and channel');
  });
});
