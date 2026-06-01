import { describe, expect, it } from 'vitest';
import { Policy } from '../src/policy/index.js';
import type { PolicySummary } from '../src/policy/index.js';

describe('Policy.check', () => {
  it('allows tools in defaults.allow', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['list-mail-messages', 'identity-get-me'] },
    });
    expect(policy.check({ userPrincipalName: null, toolName: 'list-mail-messages' })).toBe(true);
    expect(policy.check({ userPrincipalName: 'u@example.com', toolName: 'identity-get-me' })).toBe(true);
  });

  it('denies tools missing from defaults.allow when there is no user entry (fail-closed)', () => {
    const policy = Policy.fromDocument({ defaults: { allow: ['identity-get-me'] } });
    expect(
      policy.check({ userPrincipalName: 'u@example.com', toolName: 'mail-message-delete' })
    ).toBe(false);
  });

  it("user.allow grants tools the user wouldn't get from defaults", () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: {
        'spencer@example.com': { allow: ['mail-draft-create'] },
      },
    });
    expect(
      policy.check({ userPrincipalName: 'spencer@example.com', toolName: 'mail-draft-create' })
    ).toBe(true);
    expect(
      policy.check({ userPrincipalName: 'other@example.com', toolName: 'mail-draft-create' })
    ).toBe(false);
  });

  it('user.deny wins over both user.allow and defaults.allow', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['download-bytes'] },
      users: {
        'contractor@example.com': {
          allow: ['download-bytes'],
          deny: ['download-bytes'],
        },
      },
    });
    expect(
      policy.check({ userPrincipalName: 'contractor@example.com', toolName: 'download-bytes' })
    ).toBe(false);
  });

  it('UPN lookup is case-insensitive', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: [] },
      users: { 'CASE@EXAMPLE.COM': { allow: ['identity-get-me'] } },
    });
    expect(policy.check({ userPrincipalName: 'case@example.com', toolName: 'identity-get-me' })).toBe(true);
    expect(policy.check({ userPrincipalName: 'Case@Example.Com', toolName: 'identity-get-me' })).toBe(true);
  });

  it('falls through to defaults when the user is unknown', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: { 'known@example.com': { allow: ['extra-tool'] } },
    });
    expect(policy.check({ userPrincipalName: 'unknown@example.com', toolName: 'identity-get-me' })).toBe(
      true
    );
    expect(policy.check({ userPrincipalName: 'unknown@example.com', toolName: 'extra-tool' })).toBe(
      false
    );
  });

  it('treats a null UPN as anonymous and only consults defaults', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: { 'someone@example.com': { allow: ['list-mail-messages'] } },
    });
    expect(policy.check({ userPrincipalName: null, toolName: 'identity-get-me' })).toBe(true);
    expect(policy.check({ userPrincipalName: null, toolName: 'list-mail-messages' })).toBe(false);
  });

  it('an empty document denies everything', () => {
    const policy = Policy.fromDocument({});
    expect(policy.check({ userPrincipalName: 'anyone@example.com', toolName: 'identity-get-me' })).toBe(
      false
    );
  });
});

describe('Policy.summary', () => {
  it('returns defaultAllow sorted alphabetically', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['z-tool', 'a-tool', 'm-tool'] },
    });
    const summary: PolicySummary = policy.summary();
    expect(summary.defaultAllow).toEqual(['a-tool', 'm-tool', 'z-tool']);
  });

  it('returns an empty defaultAllow when no defaults are set', () => {
    const policy = Policy.fromDocument({});
    expect(policy.summary().defaultAllow).toEqual([]);
  });

  it('returns per-user entries sorted by UPN', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: {
        'z@example.com': { allow: ['tool-z'] },
        'a@example.com': { allow: ['tool-a'] },
      },
    });
    const summary = policy.summary();
    expect(summary.users[0].upn).toBe('a@example.com');
    expect(summary.users[1].upn).toBe('z@example.com');
  });

  it('returns allow and deny arrays sorted alphabetically per user', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: {
        'u@example.com': {
          allow: ['z-allowed', 'a-allowed'],
          deny: ['y-denied', 'b-denied'],
        },
      },
    });
    const user = policy.summary().users[0];
    expect(user.allow).toEqual(['a-allowed', 'z-allowed']);
    expect(user.deny).toEqual(['b-denied', 'y-denied']);
  });

  it('returns empty users array when no per-user entries exist', () => {
    const policy = Policy.fromDocument({ defaults: { allow: ['identity-get-me'] } });
    expect(policy.summary().users).toEqual([]);
  });

  it('per-user UPN is normalized to lowercase (matches check() behaviour)', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: [] },
      users: { 'UPPER@EXAMPLE.COM': { allow: ['identity-get-me'] } },
    });
    const user = policy.summary().users[0];
    expect(user.upn).toBe('upper@example.com');
  });
});
