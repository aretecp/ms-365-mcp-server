#!/usr/bin/env node

import 'dotenv/config';
import { parseArgs } from './cli.js';
import logger from './logger.js';
import MicrosoftGraphServer from './server.js';
import { getSecrets } from './secrets.js';
import { SessionStore, assertSessionKeyAvailable } from './sessions/store.js';
import { SessionManager } from './sessions/manager.js';
import { Policy } from './policy/index.js';
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

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    assertSessionKeyAvailable();
    const secrets = await getSecrets();
    const sessionStore = new SessionStore();
    const sessionManager = new SessionManager({ store: sessionStore, secrets });
    const policy = Policy.fromFile();

    const server = new MicrosoftGraphServer({
      options: args,
      secrets,
      sessionManager,
      policy,
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
