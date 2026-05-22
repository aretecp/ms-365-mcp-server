import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import logger from '../logger.js';

/**
 * Per-user, per-tool authorization policy that runs in front of every
 * Graph call. Sits on top of (not in place of) Entra's own scope checks.
 *
 * Precedence:
 *   user.deny  ➜ deny
 *   user.allow ➜ allow
 *   defaults.allow ➜ allow
 *   otherwise  ➜ deny (fail-closed)
 *
 * Users are looked up by userPrincipalName (UPN, email-shaped). Unknown
 * users fall through to defaults.allow.
 */

export interface PolicyDocument {
  defaults?: {
    allow?: string[];
  };
  users?: Record<
    string,
    {
      allow?: string[];
      deny?: string[];
    }
  >;
}

const POLICY_PATH_ENV = 'MS365_MCP_POLICY_PATH';
const DEFAULT_POLICY_PATH = path.join(process.cwd(), 'policy', 'policy.yaml');

function resolvePolicyPath(): string {
  const env = process.env[POLICY_PATH_ENV]?.trim();
  return env && env !== '' ? env : DEFAULT_POLICY_PATH;
}

function normalizeList(arr: unknown): Set<string> {
  if (!Array.isArray(arr)) return new Set();
  const out = new Set<string>();
  for (const v of arr) if (typeof v === 'string' && v !== '') out.add(v);
  return out;
}

interface NormalizedPolicy {
  defaultAllow: Set<string>;
  perUser: Map<string, { allow: Set<string>; deny: Set<string> }>;
  sourcePath: string;
}

function normalize(raw: PolicyDocument, sourcePath: string): NormalizedPolicy {
  const defaultAllow = normalizeList(raw.defaults?.allow);
  const perUser = new Map<string, { allow: Set<string>; deny: Set<string> }>();
  if (raw.users) {
    for (const [upn, entry] of Object.entries(raw.users)) {
      perUser.set(upn.toLowerCase(), {
        allow: normalizeList(entry?.allow),
        deny: normalizeList(entry?.deny),
      });
    }
  }
  return { defaultAllow, perUser, sourcePath };
}

export class Policy {
  constructor(private readonly doc: NormalizedPolicy) {}

  static fromFile(filePath?: string): Policy {
    const resolved = filePath ?? resolvePolicyPath();
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `Policy file not found at ${resolved}. ` +
          `Copy policy/policy.yaml.example to ${resolved} or set ${POLICY_PATH_ENV}.`
      );
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (error) {
      throw new Error(`Failed to parse policy YAML at ${resolved}: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`Policy file at ${resolved} must be a YAML mapping.`);
    }
    const normalized = normalize(parsed as PolicyDocument, resolved);
    logger.info(
      `Loaded policy from ${resolved}: ${normalized.defaultAllow.size} default-allow tools, ${normalized.perUser.size} per-user entries`
    );
    return new Policy(normalized);
  }

  /** Visible for tests; production code uses fromFile. */
  static fromDocument(doc: PolicyDocument): Policy {
    return new Policy(normalize(doc, '<inline>'));
  }

  check(args: { userPrincipalName: string | null; toolName: string }): boolean {
    const upn = args.userPrincipalName?.toLowerCase() ?? null;
    if (upn) {
      const entry = this.doc.perUser.get(upn);
      if (entry) {
        if (entry.deny.has(args.toolName)) return false;
        if (entry.allow.has(args.toolName)) return true;
      }
    }
    return this.doc.defaultAllow.has(args.toolName);
  }

  /** Mostly for diagnostics. Returns the file path the policy was loaded from. */
  source(): string {
    return this.doc.sourcePath;
  }
}
