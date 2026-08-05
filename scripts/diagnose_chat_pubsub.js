/**
 * Read-only diagnostics for Google Chat → Pub/Sub delivery.
 */

import { PubSub } from '@google-cloud/pubsub';
import { loadConfig, validateStartupConfig } from '../src/lib/config.js';

async function main() {
  const config = loadConfig();
  validateStartupConfig(config);

  const topicPath = `projects/${config.google.projectId}/topics/${config.google.topicId}`;
  const subscriptionPath = `projects/${config.google.projectId}/subscriptions/${config.google.subscriptionId}`;

  console.log('Keeper Google Chat — Pub/Sub diagnostics');
  console.log('='.repeat(50));
  console.log(`Project:      ${config.google.projectId}`);
  console.log(`Topic:        ${topicPath}`);
  console.log(`Subscription: ${subscriptionPath}`);
  console.log();

  const pubsub = new PubSub({
    projectId: config.google.projectId,
    keyFilename: config.google.credentialsFile,
  });
  const subscription = pubsub.subscription(config.google.subscriptionId);

  console.log('[1/2] Worker can access subscription...');
  try {
    const [exists] = await subscription.exists();
    if (!exists) {
      console.log('  FAIL — subscription does not exist');
      process.exit(1);
    }
    console.log('  OK — subscription exists');
  } catch (error) {
    console.log('  FAIL — cannot access subscription');
    console.log(`  ${error.message}`);
    process.exit(1);
  }

  console.log();
  console.log('[2/2] Chat API configuration checklist (manual — Console only)');
  console.log(
    `  Open: https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${config.google.projectId}`,
  );
  console.log();
  console.log('  Confirm ALL of the following, then Save:');
  console.log('  [ ] Connection settings = Cloud Pub/Sub');
  console.log(`  [ ] Topic = ${topicPath}`);
  console.log('  [ ] Your email is listed under Visibility');
  console.log('  [ ] Slash command ID 1 = /keeper-request-record');
  console.log();
  console.log('  Topic IAM (Pub/Sub Publisher):');
  console.log('  [ ] chat-api-push@system.gserviceaccount.com');
  console.log('  [ ] service-<PROJECT_NUMBER>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com');
  console.log();
  console.log('  Subscription IAM (Pub/Sub Subscriber):');
  console.log('  [ ] worker service account from service-account.json');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
