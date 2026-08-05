/**
 * Application configuration loader.
 * Precedence: environment variables > config.yaml > defaults.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

dotenv.config();

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function projectIdFromServiceAccount(credentialsFile) {
  try {
    const absolute = path.resolve(credentialsFile);
    if (!fs.existsSync(absolute)) return '';
    const payload = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    return typeof payload.project_id === 'string' ? payload.project_id : '';
  } catch {
    return '';
  }
}

/**
 * @returns {import('./types.js').AppConfig}
 */
export function loadConfig(configPath) {
  const resolvedPath = path.resolve(
    configPath || env('CONFIG_PATH', 'config.yaml'),
  );

  let fileData = {};
  if (fs.existsSync(resolvedPath)) {
    fileData = yaml.load(fs.readFileSync(resolvedPath, 'utf8')) || {};
  }

  const google = fileData.google || {};
  const chat = fileData.chat || {};
  const keeper = fileData.keeper || {};

  const credentialsFile = path.resolve(
    env('GOOGLE_APPLICATION_CREDENTIALS', google.credentials_file || './service-account.json'),
  );

  let projectId = env('GOOGLE_PROJECT_ID', google.project_id || '');
  if (!projectId) {
    projectId = projectIdFromServiceAccount(credentialsFile);
  }

  return {
    configPath: resolvedPath,
    google: {
      projectId,
      subscriptionId: env('GOOGLE_SUBSCRIPTION_ID', google.subscription_id || 'keeper-chat-events-sub'),
      topicId: env('GOOGLE_TOPIC_ID', google.topic_id || 'keeper-chat-events'),
      credentialsFile,
    },
    chat: {
      appName: env('CHAT_APP_NAME', chat.app_name || 'Keeper Security'),
      commandRequestRecordId: envInt(
        'CHAT_COMMAND_REQUEST_RECORD_ID',
        Number(chat.command_request_record_id ?? 1),
      ),
      commandRequestFolderId: envInt(
        'CHAT_COMMAND_REQUEST_FOLDER_ID',
        Number(chat.command_request_folder_id ?? 2),
      ),
      commandOneTimeShareId: envInt(
        'CHAT_COMMAND_ONE_TIME_SHARE_ID',
        Number(chat.command_one_time_share_id ?? 3),
      ),
      commandCreateSecretId: envInt(
        'CHAT_COMMAND_CREATE_SECRET_ID',
        Number(chat.command_create_secret_id ?? 4),
      ),
      approvalsSpaceId: env('CHAT_APPROVALS_SPACE_ID', chat.approvals_space_id || ''),
    },
    keeper: {
      serviceUrl: env('KEEPER_SERVICE_URL', keeper.service_url || 'http://localhost:8900/api/v2/'),
      apiKey: env('KEEPER_API_KEY', keeper.api_key || ''),
    },
  };
}

export function validateStartupConfig(config) {
  const missing = [];
  if (!config.google.projectId) missing.push('google.project_id');
  if (!config.google.subscriptionId) missing.push('google.subscription_id');
  if (!fs.existsSync(config.google.credentialsFile)) {
    missing.push(`google.credentials_file (${config.google.credentialsFile})`);
  }
  if (missing.length) {
    throw new Error(
      `Missing configuration: ${missing.join(', ')}. Copy config.example.yaml to config.yaml and place service-account.json in the project root.`,
    );
  }
}
