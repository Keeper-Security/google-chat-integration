/**
 * Keeper Secrets Manager (KSM) helpers —  Google Chat.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from './logger.js';

/**
 * @returns {boolean}
 */
export function isRunningInDocker() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    if (fs.existsSync('/run/.containerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
}

/**
 * Replace localhost with the compose service name so containers can reach Commander.
 * @param {string} serviceUrl
 * @param {string} [host]
 */
export function fixServiceUrlForDocker(serviceUrl, host = 'commander-gchat') {
  if (!serviceUrl || !isRunningInDocker()) return serviceUrl;
  const target = process.env.COMMANDER_HOST || host;
  return String(serviceUrl)
    .replace(/localhost/gi, target)
    .replace(/127\.0\.0\.1/g, target);
}

/**
 * @param {string} input
 */
export function isBase64Config(input) {
  if (!input) return false;
  const s = String(input).trim();
  if (
    s.startsWith('/') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('~') ||
    fs.existsSync(s)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/**
 * Decode base64 KSM config to a temp file, or return an existing path.
 * @param {string} ksmConfigInput
 * @returns {string|null}
 */
export function processKsmConfig(ksmConfigInput) {
  const logger = getLogger();
  if (!ksmConfigInput) return null;
  const input = String(ksmConfigInput).trim();

  if (isBase64Config(input)) {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksm-'));
      const configPath = path.join(dir, 'ksm-config.json');
      const decoded = Buffer.from(input, 'base64').toString('utf8');
      const configData = JSON.parse(decoded);
      if (!configData || typeof configData !== 'object') {
        logger.error('Invalid KSM config format — must be a JSON object');
        return null;
      }
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      return configPath;
    } catch (error) {
      logger.error({ err: error }, 'Failed to process base64 KSM config');
      return null;
    }
  }

  if (fs.existsSync(input)) return path.resolve(input);
  logger.error('KSM config file not found');
  return null;
}

function unwrapFieldValue(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    if (!raw.length) return null;
    return unwrapFieldValue(raw[0]);
  }
  if (typeof raw === 'object') {
    if (Object.prototype.hasOwnProperty.call(raw, 'value')) {
      return unwrapFieldValue(raw.value);
    }
    // Full JSON blob (e.g. service account object stored as JSON field)
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  const text = String(raw).trim();
  return text || null;
}

function normalizeLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

/**
 * Read a standard or custom field by label (and common aliases).
 * @param {object} record - KSM KeeperRecord
 * @param {string} label
 * @returns {string|null}
 */
export function extractFieldValue(record, label) {
  if (!record || !label) return null;
  const data = record.data || {};
  const wanted = normalizeLabel(label);
  const variations = new Set([
    wanted,
    wanted.replace(/_/g, '-'),
    String(label).trim(),
  ]);

  const pools = [...(data.fields || []), ...(data.custom || [])];
  for (const field of pools) {
    const candidates = [field.label, field.type].filter(Boolean);
    for (const candidate of candidates) {
      if (variations.has(normalizeLabel(candidate)) || variations.has(String(candidate))) {
        const value = unwrapFieldValue(field.value);
        if (value != null) return value;
      }
    }
  }
  return null;
}

/**
 * Parse notes JSON if present on the record.
 * @param {object} record
 * @returns {object|null}
 */
export function extractNotesJson(record) {
  const notes = extractFieldValue(record, 'notes');
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
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
 * Write Google service-account JSON to a temp file for Chat/Pub/Sub clients.
 * @param {string} jsonText
 * @returns {string|null} absolute path
 */
export function writeServiceAccountFile(jsonText) {
  const logger = getLogger();
  if (!jsonText) return null;
  let text = String(jsonText).trim();

  // Allow base64-wrapped SA JSON
  if (!text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.trim().startsWith('{')) text = decoded.trim();
    } catch {
      // keep original
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      logger.error('google_service_account_json is not a JSON object');
      return null;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksm-gchat-'));
    const filePath = path.join(dir, 'service-account.json');
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return filePath;
  } catch (error) {
    logger.error({ err: error }, 'Failed to write google_service_account_json');
    return null;
  }
}

/**
 * Map COMMANDER_RECORD fields → keeper section.
 * @param {object} record
 */
export function mapCommanderRecord(record) {
  const notes = extractNotesJson(record) || {};
  let serviceUrl =
    extractFieldValue(record, 'service_url') ||
    extractFieldValue(record, 'service-url') ||
    notes.service_url ||
    null;
  const apiKey =
    extractFieldValue(record, 'api_key') ||
    extractFieldValue(record, 'api-key') ||
    notes.api_key ||
    null;

  if (serviceUrl) serviceUrl = fixServiceUrlForDocker(serviceUrl);

  /** @type {Record<string, string>} */
  const keeper = {};
  if (serviceUrl) keeper.service_url = serviceUrl;
  if (apiKey) keeper.api_key = apiKey;
  return Object.keys(keeper).length ? { keeper } : {};
}

/**
 * Map GCHAT_RECORD fields → google / chat / epm / device_approval.
 * Vault labels use pedm_* (Slack parity) → app epm section.
 * @param {object} record
 */
export function mapGchatRecord(record) {
  const notes = extractNotesJson(record) || {};
  const pick = (label, ...aliases) => {
    for (const key of [label, ...aliases]) {
      const fromField = extractFieldValue(record, key);
      if (fromField != null) return fromField;
      if (notes[key] != null && notes[key] !== '') return String(notes[key]);
    }
    return null;
  };

  const saJson = pick('google_service_account_json');
  const credentialsFile = saJson ? writeServiceAccountFile(saJson) : null;

  /** @type {Record<string, any>} */
  const google = {};
  const projectId = pick('google_project_id');
  const subscriptionId = pick('google_subscription_id');
  const topicId = pick('google_topic_id');
  if (projectId) google.project_id = projectId;
  if (subscriptionId) google.subscription_id = subscriptionId;
  if (topicId) google.topic_id = topicId;
  if (credentialsFile) google.credentials_file = credentialsFile;

  /** @type {Record<string, any>} */
  const chat = {};
  const approvalsSpaceId = pick('chat_approval_space_id', 'chat_approvals_space_id');
  const cmdRecord = pick('chat_command_request_record_id');
  const cmdFolder = pick('chat_command_request_folder_id');
  const cmdExternal = pick('chat_command_external_share_id');
  const cmdCreate = pick('chat_command_create_secret_id');
  if (approvalsSpaceId) chat.approvals_space_id = approvalsSpaceId;
  if (cmdRecord != null) chat.command_request_record_id = asInt(cmdRecord, 1);
  if (cmdFolder != null) chat.command_request_folder_id = asInt(cmdFolder, 2);
  if (cmdExternal != null) chat.command_external_share_id = asInt(cmdExternal, 3);
  if (cmdCreate != null) chat.command_create_secret_id = asInt(cmdCreate, 4);

  /** @type {Record<string, any>} */
  const epm = {};
  const pedmEnabled = pick('pedm_enabled');
  const pedmInterval = pick('pedm_polling_interval');
  if (pedmEnabled != null) epm.enabled = asBool(pedmEnabled, false);
  if (pedmInterval != null) epm.polling_interval_in_sec = asInt(pedmInterval, 120);

  /** @type {Record<string, any>} */
  const deviceApproval = {};
  const deviceEnabled = pick('device_approval_enabled');
  const deviceInterval = pick('device_approval_polling_interval');
  if (deviceEnabled != null) deviceApproval.enabled = asBool(deviceEnabled, false);
  if (deviceInterval != null) {
    deviceApproval.polling_interval_in_sec = asInt(deviceInterval, 120);
  }

  /** @type {Record<string, any>} */
  const out = {};
  if (Object.keys(google).length) out.google = google;
  if (Object.keys(chat).length) out.chat = chat;
  if (Object.keys(epm).length) out.epm = epm;
  if (Object.keys(deviceApproval).length) out.device_approval = deviceApproval;
  return out;
}

/**
 * Deep-merge section objects (KSM overlays file).
 * @param {object} base
 * @param {object} overlay
 */
export function mergeConfigSections(base, overlay) {
  const result = { ...(base || {}) };
  for (const [section, values] of Object.entries(overlay || {})) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      result[section] = values;
      continue;
    }
    result[section] = { ...(result[section] || {}), ...values };
  }
  return result;
}

/**
 * Fetch Commander + Google Chat credentials from KSM.
 * @param {{ ksmConfig?: string|null, commanderRecord?: string|null, gchatRecord?: string|null }} options
 * @returns {Promise<{ data: object, ksmLoaded: boolean }>}
 */
export async function fetchCredentialsFromKsm(options = {}) {
  const logger = getLogger();
  const ksmConfig = options.ksmConfig || null;
  const commanderRecord = options.commanderRecord || null;
  const gchatRecord = options.gchatRecord || null;

  if (!ksmConfig) {
    return { data: {}, ksmLoaded: false };
  }

  let getSecrets;
  let getSecretsByTitle;
  let localConfigStorage;
  try {
    const ksm = await import('@keeper-security/secrets-manager-core');
    getSecrets = ksm.getSecrets;
    getSecretsByTitle = ksm.getSecretsByTitle;
    localConfigStorage = ksm.localConfigStorage;
  } catch (error) {
    logger.warn(
      { err: error },
      'KSM SDK not available — install @keeper-security/secrets-manager-core',
    );
    return { data: {}, ksmLoaded: false };
  }

  const configPath = processKsmConfig(ksmConfig);
  if (!configPath) {
    logger.error('Failed to process KSM_CONFIG');
    return { data: {}, ksmLoaded: false };
  }

  const storage = localConfigStorage(configPath);
  const smOptions = { storage };

  /**
   * @param {string} identifier
   */
  async function getRecordByUidOrTitle(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;

    try {
      const { records } = await getSecrets(smOptions, [id]);
      if (records?.length) return records[0];
    } catch (error) {
      logger.debug(
        { err: error, identifier: id },
        'KSM UID lookup failed; trying title',
      );
    }

    try {
      const byTitle = await getSecretsByTitle(smOptions, id);
      const list = Array.isArray(byTitle) ? byTitle : byTitle ? [byTitle] : [];
      if (!list.length) {
        logger.error({ identifier: id }, 'KSM record not found by UID or title');
        return null;
      }
      if (list.length > 1) {
        logger.error(
          { identifier: id, count: list.length },
          'Multiple KSM records match title — use a UID',
        );
        return null;
      }
      return list[0];
    } catch (error) {
      logger.error({ err: error, identifier: id }, 'KSM title lookup failed');
      return null;
    }
  }

  let data = {};
  const fetched = [];

  if (commanderRecord) {
    try {
      const secret = await getRecordByUidOrTitle(commanderRecord);
      if (secret) {
        const mapped = mapCommanderRecord(secret);
        data = mergeConfigSections(data, mapped);
        if (mapped.keeper) fetched.push('Service Mode Credentials');
        else logger.warn('No Keeper fields extracted from COMMANDER_RECORD');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch COMMANDER_RECORD from KSM');
    }
  }

  if (gchatRecord) {
    try {
      const secret = await getRecordByUidOrTitle(gchatRecord);
      if (secret) {
        const mapped = mapGchatRecord(secret);
        data = mergeConfigSections(data, mapped);
        if (mapped.google || mapped.chat) fetched.push('Google Chat Credentials');
        else logger.warn('No Google Chat fields extracted from GCHAT_RECORD');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch GCHAT_RECORD from KSM');
    }
  }

  if (fetched.length) {
    logger.info(
      { items: fetched },
      'Credentials fetched successfully from KSM vault',
    );
  }

  return { data, ksmLoaded: Object.keys(data).length > 0 };
}

/**
 * Resolve KSM bootstrap inputs (env + Docker secret files).
 */
export function resolveKsmBootstrap() {
  let ksmConfig = null;
  let commanderRecord = null;
  let gchatRecord = null;

  const dockerKsm = '/run/secrets/ksm-config';
  const dockerCommander = '/run/secrets/commander-record';
  const dockerGchat = '/run/secrets/gchat-record';

  try {
    if (fs.existsSync(dockerKsm)) {
      ksmConfig = fs.readFileSync(dockerKsm, 'utf8').trim();
    }
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(dockerCommander)) {
      commanderRecord = fs.readFileSync(dockerCommander, 'utf8').trim();
    }
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(dockerGchat)) {
      gchatRecord = fs.readFileSync(dockerGchat, 'utf8').trim();
    }
  } catch {
    // ignore
  }

  if (!ksmConfig) ksmConfig = process.env.KSM_CONFIG || null;
  if (!commanderRecord) {
    commanderRecord = process.env.COMMANDER_RECORD || 'CSMD config';
  }
  if (!gchatRecord) {
    gchatRecord = process.env.GCHAT_RECORD || 'CSMD google chat config';
  }

  return { ksmConfig, commanderRecord, gchatRecord };
}
