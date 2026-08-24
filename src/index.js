/**
 * Keeper Google Chat App — Pub/Sub pull listener entrypoint.
 *
 * Requires the Chat app to be configured as a Chat API interaction-events app
 * (NOT a Workspace add-on) with a Cloud Pub/Sub connection. In that mode,
 * Google Chat delivers MESSAGE, ADDED_TO_SPACE, and CARD_CLICKED (button)
 * events to the Pub/Sub topic, so card interactions work without a public
 * HTTP endpoint.
 */

import { PubSub } from '@google-cloud/pubsub';
import { KeeperGoogleChatApp } from './app.js';
import { loadConfig, validateStartupConfig } from './lib/config.js';
import { createLogger, getLogger } from './lib/logger.js';

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function printBanner(ok, title, detail = '') {
  const color = ok ? ansi.green : ansi.red;
  const mark = ok ? '✓' : '✗';
  const line = '='.repeat(64);
  console.log(`\n${color}${ansi.bold}${line}${ansi.reset}`);
  console.log(`${color}${ansi.bold}  ${mark}  ${title}${ansi.reset}`);
  if (detail) console.log(`${ansi.cyan}  ${detail}${ansi.reset}`);
  console.log(`${color}${ansi.bold}${line}${ansi.reset}\n`);
}

async function main() {
  createLogger();
  const logger = getLogger();

  const config = await loadConfig();

  try {
    validateStartupConfig(config);
  } catch (error) {
    logger.error({ err: error }, 'Invalid startup configuration');
    process.exit(1);
  }

  if (config.ksmLoaded) {
    logger.info('Configuration loaded from KSM (overlays local YAML if present)');
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = config.google.credentialsFile;

  const subscriptionPath = `projects/${config.google.projectId}/subscriptions/${config.google.subscriptionId}`;

  const pubsub = new PubSub({
    projectId: config.google.projectId,
    keyFilename: config.google.credentialsFile,
  });
  const subscription = pubsub.subscription(config.google.subscriptionId, {
    flowControl: { maxMessages: 10 },
  });

  const app = new KeeperGoogleChatApp(config);
  const healthy = await app.keeperClient.healthCheck();

  printBanner(true, 'GOOGLE CHAT SERVER STARTED', subscriptionPath);

  if (healthy) {
    printBanner(true, 'KEEPER SERVICE MODE ACCESSIBLE', config.keeper.serviceUrl);
 // Resolve vault host via Commander `server` for deep links.
    const serverDomain = await app.keeperClient.getServerDomain();
    if (app.keeperClient._serverDomainFromCommander) {
      logger.info({ serverDomain }, 'Keeper server domain ready (from Commander)');
    } else {
      logger.warn(
        {
          serverDomain,
          fix: 'Allowlist the `server` command in Commander Service Mode, then restart',
        },
        'Keeper server domain is the DEFAULT fallback — Commander `server` was not allowed',
      );
    }
  } else {
    printBanner(
      false,
      'KEEPER SERVICE MODE NOT REACHABLE',
      `${config.keeper.serviceUrl}  — check Commander Service Mode`,
    );
    logger.warn(
      { serviceUrl: config.keeper.serviceUrl },
      'Keeper Commander health check failed',
    );
  }

  const epmStatus = config.epm?.enabled ? 'enabled' : 'disabled';
  logger.info(
    `EPM poller configuration: ${epmStatus} (interval: ${config.epm?.pollingIntervalInSec ?? 120}s)`,
  );
  const deviceStatus = config.deviceApproval?.enabled ? 'enabled' : 'disabled';
  logger.info(
    `Cloud SSO Device Approval poller configuration: ${deviceStatus} (interval: ${config.deviceApproval?.pollingIntervalInSec ?? 120}s)`,
  );
  app.startBackgroundJobs();

  let stopping = false;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    try {
      app.stopBackgroundJobs();
      await subscription.close();
    } catch (error) {
      logger.warn({ err: error }, 'Error closing subscription');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  subscription.on('message', async (message) => {
    try {
      const event = JSON.parse(message.data.toString('utf8'));
      await app.handleEvent(event);
    } catch (error) {
      logger.error({ err: error, messageId: message.id }, 'Failed to process Pub/Sub message');
    } finally {
      message.ack();
    }
  });

  subscription.on('error', (error) => {
    const message = String(error?.message || error);
    if (message.includes('PERMISSION_DENIED') || error?.code === 7) {
      logger.error(
        { err: error, subscriptionPath },
        'Pub/Sub permission denied. Grant roles/pubsub.subscriber on the subscription to the worker service account.',
      );
      process.exit(1);
      return;
    }
    logger.error({ err: error }, 'Pub/Sub subscription error');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
