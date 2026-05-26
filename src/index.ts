#!/usr/bin/env node

import 'dotenv/config';
import { parseArgs } from './cli.js';
import logger from './logger.js';
import MicrosoftGraphServer from './server.js';
import { getSecrets } from './secrets.js';
import { SessionStore, assertSessionKeyAvailable } from './sessions/store.js';
import { SessionManager } from './sessions/manager.js';
import { PolicyManager } from './policy/index.js';
import { dumpError, getActiveResources } from './crash-logging.js';
import { version } from './version.js';

process.on('unhandledRejection', (reason) => {
  const dump = {
    kind: 'unhandledRejection',
    reason: dumpError(reason),
    activeResources: getActiveResources(),
  };
  console.error('[microsoft-mcp] unhandledRejection', JSON.stringify(dump));
  logger.error('unhandledRejection', dump);
});

process.on('uncaughtException', (err, origin) => {
  const dump = {
    kind: 'uncaughtException',
    origin,
    error: dumpError(err),
    activeResources: getActiveResources(),
  };
  console.error('[microsoft-mcp] uncaughtException', JSON.stringify(dump));
  logger.error('uncaughtException', dump);
});

/**
 * Parse and validate the comma-separated MS365_MCP_POLICY_ADMINS env var.
 * Returns a Set of lowercased UPNs. Fails fast if empty / unset so a
 * misconfiguration can't accidentally lock everyone out of the admin UI.
 */
function loadPolicyAdmins(): Set<string> {
  const raw = process.env.MS365_MCP_POLICY_ADMINS ?? '';
  const set = new Set(
    raw
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0)
  );
  if (set.size === 0) {
    throw new Error(
      'MS365_MCP_POLICY_ADMINS is required (comma-separated list of admin userPrincipalNames). ' +
        'No-one can access the admin UI without it.'
    );
  }
  return set;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    assertSessionKeyAvailable();
    const secrets = await getSecrets();
    const sessionStore = new SessionStore();
    const sessionManager = new SessionManager({ store: sessionStore, secrets });
    const policyManager = PolicyManager.fromFile();
    const policyAdmins = loadPolicyAdmins();

    // Hot-reload the policy on SIGHUP. Failures are logged inside reload(); the
    // process keeps running with the previously-loaded Policy.
    process.on('SIGHUP', () => {
      policyManager.reload().catch(() => {
        /* already logged by PolicyManager.runReload */
      });
    });

    const server = new MicrosoftGraphServer({
      options: args,
      secrets,
      sessionManager,
      policy: policyManager,
      policyAdmins,
    });
    server.initialize(version);
    await server.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Startup error: ${message}`);
    console.error(message);
    process.exit(1);
  }
}

main();
