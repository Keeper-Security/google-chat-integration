/**
 * Keeper create-record, one-time share, and create-secret folder helpers.
 */

import { mapOneTimeShareError } from '../commander_errors.js';
import {
  extractOneTimeShareUrl,
  extractUidFromCreateResponse,
  flattenMessage,
  sanitizeCommanderError,
  shellQuote,
  sleep,
} from '../commander_helpers.js';
import {
  formatDurationFromSeconds,
  parseDurationToSeconds,
  secondsToExpireFlag,
  secondsToSelfDestructFlag,
} from '../utils.js';

/**
 * Create a one-time share link (Slack parity).
 * Commander: `one-time-share create[--editable] <uid> -e <expire>`
 */
export async function createOneTimeShare(client, {
  recordUid,
  durationSeconds = 300,
  editable = false,
}) {
  const expireIn =
    durationSeconds == null
      ? '7d'
      : secondsToExpireFlag(durationSeconds) || '7d';
  const editableFlag = editable ? ' --editable' : '';
  const command = `one-time-share create${editableFlag} ${recordUid} -e ${expireIn}`;

  const grantResult = await client.executeCommandSafe(command, 30000);
  if (!grantResult.ok) {
    const errText = grantResult.error?.error || 'Commander command failed';
    return mapOneTimeShareError(errText);
  }

  const data = grantResult.data || {};
  if (data.status !== 'success') {
    return mapOneTimeShareError(flattenMessage(data.message || data.error));
  }

  const shareUrl = extractOneTimeShareUrl(data);
  if (!shareUrl) {
    return {
      success: false,
      error: 'Share link created but URL not found in response',
      raw_response: data,
    };
  }

  return {
    success: true,
    share_url: shareUrl,
    expires_at:
      durationSeconds == null
        ? 'Never (7 days default)'
        : formatDurationFromSeconds(durationSeconds),
    duration: expireIn,
    editable: Boolean(editable),
  };
}

/**
 * Shared folders visible to a user via `share-report -f --format=json`.
 * Slack parity: filter rows where `Shared To` matches the user email.
 * @param {string} userEmail
 * @returns {Promise<Array<{ uid: string, name: string, type: string, is_nsf: boolean }>>}
 */
export async function getUserSharedFolders(client, userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return [];

  const submitted = await client.executeCommandSafe(
    'share-report -f --format=json',
    30000,
  );
  if (!submitted.ok) {
    client.logger.error({ err: submitted.error }, 'share-report failed');
    return [];
  }

  const resultData = submitted.data || {};
  if (resultData.status === 'error') {
    client.logger.error(
      { message: resultData.message },
      'share-report returned error',
    );
    return [];
  }

  const rows = client.extractRecords(resultData);
  const seen = new Set();
  const folders = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const sharedTo = String(item['Shared To'] || item.shared_to || '').toLowerCase();
    if (sharedTo !== email) continue;

    const uid = String(item['Folder UID'] || item.folder_uid || item.uid || '');
    const name = String(item['Folder Name'] || item.folder_name || item.name || '');
    const folderType = String(item.Type || item.type || 'Shared Folder');
    const isNsf = folderType.trim().toLowerCase() === 'nested share folder';
    if (!uid || !name || seen.has(uid)) continue;
    seen.add(uid);
    folders.push({
      uid,
      name,
      type: folderType,
      is_nsf: isNsf,
    });
  }

  client.logger.debug(
    { count: folders.length, email },
    'Retrieved user shared folders',
  );
  return folders;
}

/**
 * Subfolders inside a shared folder via `tree -s -v <uid>`.
 * @param {string} sharedFolderUid
 * @returns {Promise<Array<{ uid: string, name: string, path: string, level: number, type: string, is_nsf: boolean }>>}
 */
export async function listSubfolders(client, sharedFolderUid) {
  const uid = String(sharedFolderUid || '').trim();
  if (!uid) return [];

  const submitted = await client.executeCommandSafe(
    `tree -s -v ${shellQuote(uid)}`,
    20000,
  );
  if (!submitted.ok) {
    client.logger.error({ err: submitted.error }, 'tree command failed');
    return [];
  }

  const resultData = submitted.data || {};
  if (resultData.status === 'error') {
    client.logger.error({ message: resultData.message }, 'tree returned error');
    return [];
  }

  const data = resultData.data;
  let treeItems = [];
  if (Array.isArray(data?.tree)) {
    treeItems = data.tree;
  } else if (Array.isArray(data)) {
    treeItems = data;
  } else if (Array.isArray(resultData.tree)) {
    treeItems = resultData.tree;
  }

  const subfolders = [];
  for (const item of treeItems) {
    if (!item || typeof item !== 'object') continue;
    const itemUid = String(item.uid || '');
    const name = String(item.name || '');
    const path = String(item.path || name);
    if (!itemUid || !name) continue;
    const isNsf = name.toLowerCase().includes('[nested share folder]');
    subfolders.push({
      uid: itemUid,
      name,
      path,
      level: Number(item.level || 0),
      type: String(item.type || 'folder'),
      is_nsf: isNsf,
    });
  }

  client.logger.debug(
    { count: subfolders.length, sharedFolderUid: uid },
    'Retrieved subfolders',
  );
  return subfolders;
}

/**
 * Create a Classic login record via `record-add`.
 * Optional self-destruct uses `--self-destruct`.
 */
export async function createRecord(client, {
  title,
  login = null,
  password = null,
  url = null,
  notes = null,
  generatePassword = false,
  selfDestructDuration = null,
  folderUid = null,
}) {
  const parts = ['record-add'];
  if (folderUid) parts.push(`--folder ${shellQuote(folderUid)}`);
  parts.push('--record-type login');
  parts.push(`--title ${shellQuote(title)}`);

  if (notes) {
    const notesForCli = String(notes).replace(/\n/g, '\\n');
    parts.push(`--notes ${shellQuote(notesForCli)}`);
  }

  if (selfDestructDuration) {
    const sdSeconds = parseDurationToSeconds(selfDestructDuration);
    const sdValue =
      sdSeconds != null
        ? secondsToSelfDestructFlag(sdSeconds)
        : selfDestructDuration;
    if (sdValue) parts.push(`--self-destruct ${sdValue}`);
  }

  if (login) parts.push(`login=${shellQuote(login)}`);
  if (password) {
    parts.push(`password=${shellQuote(password)}`);
  } else if (generatePassword) {
    parts.push('password=$GEN');
  }
  if (url) parts.push(`url=${shellQuote(url)}`);

  const submitted = await client.executeCommandSafe(parts.join(' '), 30000);
  if (!submitted.ok) return submitted.error;

  return client.parseCreateRecordResult(submitted.data, {
    title,
    password,
    generatePassword,
    selfDestructDuration,
    isNsf: false,
  });
}

/**
 * Create a Nested Share Folder login record via `nsf-record-add`.
 * Self-destruct is Classic-only and not supported here.
 */
export async function createNsfRecord(client, {
  title,
  login = null,
  password = null,
  url = null,
  notes = null,
  generatePassword = false,
  folderUid = null,
}) {
  const parts = [
    'nsf-record-add',
    `--title ${shellQuote(title)}`,
    '--record-type login',
  ];
  if (folderUid) parts.push(`--folder ${shellQuote(folderUid)}`);
  if (notes) {
    const notesForCli = String(notes).replace(/\n/g, '\\n');
    parts.push(`--notes ${shellQuote(notesForCli)}`);
  }
  if (login) parts.push(`login=${shellQuote(login)}`);
  if (password) {
    parts.push(`password=${shellQuote(password)}`);
  } else if (generatePassword) {
    parts.push('password=$GEN');
  }
  if (url) parts.push(`url=${shellQuote(url)}`);
  parts.push('-f');

  const submitted = await client.executeCommandSafe(parts.join(' '), 30000);
  if (!submitted.ok) return submitted.error;

  return client.parseCreateRecordResult(submitted.data, {
    title,
    password,
    generatePassword,
    selfDestructDuration: null,
    isNsf: true,
  });
}

/**
 * @param {object} resultData
 * @param {{ title: string, password?: string|null, generatePassword?: boolean, selfDestructDuration?: string|null, isNsf?: boolean }} meta
 */
export async function parseCreateRecordResult(client, resultData, meta) {
  const data = resultData || {};
  if (data.status !== 'success') {
    const errorMsg =
      flattenMessage(data.error || data.message) || 'Unknown error';
    return {
      success: false,
      error: `Failed to create record: ${sanitizeCommanderError(errorMsg)}`,
    };
  }

  let recordUid = extractUidFromCreateResponse(data);
  if (!recordUid && meta.title) {
    try {
      await sleep(2000);
      const search = await client.searchRecords(meta.title, 5);
      if (search.records?.length) {
        recordUid = search.records[0].uid;
      }
    } catch (err) {
      client.logger.warn({ err }, 'Failed to search for newly created record');
    }
  }

  if (!recordUid) {
    return {
      success: true,
      record_uid: 'Unknown',
      title: meta.title,
      is_nsf: Boolean(meta.isNsf),
      note: 'Record created but UID could not be retrieved.',
    };
  }

  return {
    success: true,
    record_uid: recordUid,
    title: meta.title,
    password: meta.generatePassword && !meta.password ? '$GEN' : meta.password || null,
    self_destruct: Boolean(meta.selfDestructDuration),
    self_destruct_duration: meta.selfDestructDuration || null,
    is_nsf: Boolean(meta.isNsf),
  };
}

