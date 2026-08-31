/**
 * Application configuration loader.
 *
 * Local: config.yaml (CONFIG_PATH)
 * Production / Docker: KSM_CONFIG + COMMANDER_RECORD + GCHAT_RECORD
 *   (KSM overlays YAML when both are present)
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  mergeConfigSections,
  resolveKsmBootstrap,
  retryFetchCredentialsFromKsm,
} from './ksm_utils.js';
import { getLogger } from './logger.js';

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

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Build runtime config object from merged YAML/KSM section data.
 * @param {object} fileData
 * @param {{ configPath?: string, ksmLoaded?: boolean }} [meta]
 */
export function buildConfigFromData(fileData = {}, meta = {}) {
  const google = fileData.google || {};
  const chat = fileData.chat || {};
  const keeper = fileData.keeper || {};
  const epm = fileData.epm || {};
  const deviceApproval = fileData.device_approval || {};

  const credentialsFile = path.resolve(
    google.credentials_file || './service-account.json',
  );

  let projectId = google.project_id || '';
  if (!projectId) {
    projectId = projectIdFromServiceAccount(credentialsFile);
  }

  return {
    configPath: meta.configPath || '',
    ksmLoaded: Boolean(meta.ksmLoaded),
    google: {
      projectId,
      subscriptionId: google.subscription_id || 'keeper-chat-events-sub',
      topicId: google.topic_id || 'keeper-chat-events',
      credentialsFile,
    },
    chat: {
      appName: chat.app_name || 'Keeper Security',
      commandRequestRecordId: asInt(chat.command_request_record_id, 1),
      commandRequestFolderId: asInt(chat.command_request_folder_id, 2),
      commandOneTimeShareId: asInt(chat.command_external_share_id, 3),
      commandCreateSecretId: asInt(chat.command_create_secret_id, 4),
      approvalsSpaceId: chat.approvals_space_id || '',
    },
    keeper: {
      serviceUrl: keeper.service_url || 'http://localhost:8900/api/v2/',
      apiKey: keeper.api_key || '',
    },
    epm: {
      enabled: asBool(epm.enabled, false),
      pollingIntervalInSec: asInt(epm.polling_interval_in_sec, 120),
    },
    deviceApproval: {
      enabled: asBool(deviceApproval.enabled, false),
      pollingIntervalInSec: asInt(deviceApproval.polling_interval_in_sec, 120),
    },
  };
}

/**
 * @param {string} [configPath]
 */
export async function loadConfig(configPath) {
  const resolvedPath = path.resolve(
    configPath || process.env.CONFIG_PATH || 'config.yaml',
  );

  let fileData = {};
  if (fs.existsSync(resolvedPath)) {
    fileData = yaml.load(fs.readFileSync(resolvedPath, 'utf8')) || {};
  }

  const bootstrap = resolveKsmBootstrap();
  let ksmLoaded = false;
  let ksmConfigured = false;
  let ksmError = null;

  // Only hit KSM when KSM_CONFIG (or docker secret) is present — local YAML mode otherwise.
  if (bootstrap.ksmConfig) {
    try {
      const result = await retryFetchCredentialsFromKsm({
        ksmConfig: bootstrap.ksmConfig,
        commanderRecord: bootstrap.commanderRecord,
        gchatRecord: bootstrap.gchatRecord,
      });
      ksmConfigured = result.ksmConfigured;
      ksmError = result.ksmError;
      if (result.ksmLoaded && result.data && Object.keys(result.data).length) {
        fileData = mergeConfigSections(fileData, result.data);
        ksmLoaded = true;
      }
    } catch (error) {
      ksmConfigured = true;
      ksmError = error;
      try {
        getLogger().warn({ err: error }, 'Failed to load configuration from KSM');
      } catch {
        // logger may not exist yet during early bootstrap
        console.warn('Failed to load configuration from KSM', error);
      }
    }
  }

  const config = buildConfigFromData(fileData, {
    configPath: resolvedPath,
    ksmLoaded,
  });
  // Attach KSM metadata for validation
  config._ksmConfigured = ksmConfigured;
  config._ksmError = ksmError;

  return config;
}

/**
 * Sync load for offline tests that only use YAML (no KSM).
 * @param {string} [configPath]
 */
export function loadConfigSync(configPath) {
  const resolvedPath = path.resolve(
    configPath || process.env.CONFIG_PATH || 'config.yaml',
  );
  let fileData = {};
  if (fs.existsSync(resolvedPath)) {
    fileData = yaml.load(fs.readFileSync(resolvedPath, 'utf8')) || {};
  }
  return buildConfigFromData(fileData, {
    configPath: resolvedPath,
    ksmLoaded: false,
  });
}

export function validateStartupConfig(config) {
  const missing = [];
  if (!config.google.projectId) missing.push('google.project_id');
  if (!config.google.subscriptionId) missing.push('google.subscription_id');
  if (!fs.existsSync(config.google.credentialsFile)) {
    missing.push(`google.credentials_file (${config.google.credentialsFile})`);
  }
  if (missing.length) {
    let hint = '';
    if (config._ksmConfigured) {
      if (config._ksmError) {
        hint = `KSM was configured but failed: ${config._ksmError.message}. Verify KSM_CONFIG, COMMANDER_RECORD, and GCHAT_RECORD are correct and the KSM vault is accessible.`;
      } else {
        hint = 'Check GCHAT_RECORD fields in KSM (google_project_id, google_subscription_id, google_service_account_json).';
      }
    } else {
      hint = 'Copy config.example.yaml to config.yaml and place service-account.json, or set KSM_CONFIG / GCHAT_RECORD.';
    }
    throw new Error(`Missing configuration: ${missing.join(', ')}. ${hint}`);
  }
}
