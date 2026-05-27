import { describe, expect, it } from 'vitest';
import { Policy } from '../src/policy/index.js';

describe('Policy.check', () => {
  it('allows tools in defaults.allow', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['list-mail-messages', 'get-me'] },
    });
    expect(policy.check({ userPrincipalName: null, toolName: 'list-mail-messages' })).toBe(true);
    expect(policy.check({ userPrincipalName: 'u@example.com', toolName: 'get-me' })).toBe(true);
  });

  it('denies tools missing from defaults.allow when there is no user entry (fail-closed)', () => {
    const policy = Policy.fromDocument({ defaults: { allow: ['get-me'] } });
    expect(
      policy.check({ userPrincipalName: 'u@example.com', toolName: 'delete-mail-message' })
    ).toBe(false);
  });

  it("user.allow grants tools the user wouldn't get from defaults", () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['get-me'] },
      users: {
        'spencer@example.com': { allow: ['create-draft-email'] },
      },
    });
    expect(
      policy.check({ userPrincipalName: 'spencer@example.com', toolName: 'create-draft-email' })
    ).toBe(true);
    expect(
      policy.check({ userPrincipalName: 'other@example.com', toolName: 'create-draft-email' })
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
      users: { 'CASE@EXAMPLE.COM': { allow: ['get-me'] } },
    });
    expect(policy.check({ userPrincipalName: 'case@example.com', toolName: 'get-me' })).toBe(true);
    expect(policy.check({ userPrincipalName: 'Case@Example.Com', toolName: 'get-me' })).toBe(true);
  });

  it('falls through to defaults when the user is unknown', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['get-me'] },
      users: { 'known@example.com': { allow: ['extra-tool'] } },
    });
    expect(policy.check({ userPrincipalName: 'unknown@example.com', toolName: 'get-me' })).toBe(
      true
    );
    expect(policy.check({ userPrincipalName: 'unknown@example.com', toolName: 'extra-tool' })).toBe(
      false
    );
  });

  it('treats a null UPN as anonymous and only consults defaults', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['get-me'] },
      users: { 'someone@example.com': { allow: ['list-mail-messages'] } },
    });
    expect(policy.check({ userPrincipalName: null, toolName: 'get-me' })).toBe(true);
    expect(policy.check({ userPrincipalName: null, toolName: 'list-mail-messages' })).toBe(false);
  });

  it('an empty document denies everything', () => {
    const policy = Policy.fromDocument({});
    expect(policy.check({ userPrincipalName: 'anyone@example.com', toolName: 'get-me' })).toBe(
      false
    );
  });
});
