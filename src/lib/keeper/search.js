/**
 * Keeper record/folder search and lookup helpers.
 */

import {
  FOLDER_ITEM_TYPES,
  folderIsNsf,
  recordIsNsf,
} from '../commander_helpers.js';
import { KeeperFolder, KeeperRecord } from '../models.js';
import { isPamRecordType, sanitizeSearchQuery } from '../utils.js';

/**
 * @param {string} recordUid
 * @returns {Promise<string|null>}
 */
export async function getRecordOwner(client, recordUid) {
  try {
    const data = await client.executeCommand(`get --format=json ${recordUid}`, 15000);
    const payload = data?.data || data;
    const userPermissions = payload?.user_permissions || payload?.userPermissions || [];
    for (const userPerm of userPermissions) {
      if (userPerm.owner) {
        return userPerm.username || userPerm.email || null;
      }
    }
    return null;
  } catch (error) {
    client.logger.warn({ err: error, recordUid }, 'Failed to get record owner');
    return null;
  }
}

/**
 * @param {string} uid
 * @returns {Promise<import('../models.js').KeeperRecord|null>}
 */
export async function getRecordByUid(client, uid) {
  const result = await client.executeCommand(`search -c r "${uid}" --format=json`);
  const records = client.parseSearchRecords(result, 50);
  const match = records.find((item) => item.uid === uid);
  return match || null;
}

/**
 * Search records by description/title (category filter).
 * @param {string} query
 * @param {number} [limit]
 * @param {{ forOneTimeShare?: boolean }} [options]
 * @returns {Promise<{ records: import('../models.js').KeeperRecord[], error: object|null }>}
 */
export async function searchRecords(client, query, limit = 10, options = {}) {
  const safeQuery = sanitizeSearchQuery(query).replace(/\\/g, '');
  if (!safeQuery) {
    return { records: [], error: null };
  }

  const submitted = await client.executeCommandSafe(
    `search -c r "${safeQuery.replace(/"/g, '')}" --format=json`,
    30000,
  );
  if (!submitted.ok) {
    return { records: [], error: submitted.error };
  }
  return {
    records: client.parseSearchRecords(submitted.data, limit, options),
    error: null,
  };
}

/**
 * @param {object} result
 * @param {number} limit
 * @param {{ forOneTimeShare?: boolean }} [options]
 */
export function parseSearchRecords(client, result, limit = 10, options = {}) {
  const forOneTimeShare = Boolean(options.forOneTimeShare);
  const data = client.extractRecords(result);
  const records = [];

  for (const item of data) {
    if (!item || typeof item !== 'object') continue;

    let uid = item.uid || item.record_uid || '';
    let title = item.title || item.record_title || item.name || 'Untitled';
    let recordType = item.type || item.record_type || 'login';
    let notes = item.notes || item.description || null;
    let isNsf = Boolean(item.is_nsf || item.isNsf);

    const details = item.details || '';
    if (details) {
      for (const part of String(details).split(', ')) {
        if (part.startsWith('Type: ')) {
          recordType = part.replace('Type: ', '').trim();
        } else if (part.startsWith('Description: ')) {
          notes = part.replace('Description: ', '').trim();
        }
      }
      isNsf = isNsf || recordIsNsf(details);
    }

    if (!uid) continue;

    if (forOneTimeShare) {
      if (isPamRecordType(recordType)) continue;
      if (isNsf) continue;
    }

    records.push(
      new KeeperRecord({
        uid,
        title,
        recordType,
        notes,
        isNsf,
      }),
    );
    if (records.length >= limit) break;
  }
  return records;
}

export function extractRecords(client, result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.records)) return result.records;
  if (Array.isArray(result.data)) return result.data;
  if (typeof result.result === 'string') {
    try {
      return client.extractRecords(JSON.parse(result.result));
    } catch {
      return [];
    }
  }
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    if (Array.isArray(result.data.records)) return result.data.records;
  }
  return [];
}

/**
 * Search shared folders (Classic + Nested) — `search -c s,d`.
 * @param {string} query
 * @param {number} [limit]
 */
export async function searchFolders(client, query, limit = 10) {
  const safeQuery = sanitizeSearchQuery(query).replace(/\\/g, '');
  if (!safeQuery) {
    return { folders: [], error: null };
  }

  const submitted = await client.executeCommandSafe(
    `search -c s,d "${safeQuery.replace(/"/g, '')}" --format=json`,
    30000,
  );
  if (!submitted.ok) {
    return { folders: [], error: submitted.error };
  }
  return {
    folders: client.parseSearchFolders(submitted.data, limit),
    error: null,
  };
}

/**
 * @param {string} folderUid
 * @returns {Promise<import('../models.js').KeeperFolder|null>}
 */
export async function getFolderByUid(client, folderUid) {
  try {
    const result = await client.executeCommand(
      `search "${folderUid}" --format=json`,
      15000,
    );
    const folders = client.parseSearchFolders(result, 50);
    const match = folders.find((item) => item.uid === folderUid);
    if (match) return match;

 // Also check raw rows for non-folder types (record submitted as folder UID).
    const rows = client.extractRecords(result);
    const exact = rows.find(
      (item) => item && typeof item === 'object' && item.uid === folderUid,
    );
    if (exact) {
      const type = String(exact.type || exact.record_type || '').toLowerCase();
      if (!FOLDER_ITEM_TYPES.has(type)) {
        return new KeeperFolder({
          uid: folderUid,
          name: exact.title || exact.name || 'Untitled',
          folderType: 'record',
          isNsf: false,
        });
      }
    }
    return null;
  } catch (error) {
    client.logger.warn({ err: error, folderUid }, 'Failed to get folder by UID');
    return null;
  }
}

/**
 * Detect rotate-on-expire eligible PAM user folder via list-sf.
 * @param {string} folderUid
 * @returns {Promise<{ isPam: boolean, error: object|null }>}
 */
export async function isPamUserFolder(client, folderUid) {
  if (!folderUid) return { isPam: false, error: null };
  const submitted = await client.executeCommandSafe(
    `list-sf ${folderUid} --roe-eligible --format=json`,
    15000,
  );
  if (!submitted.ok) {
    return { isPam: false, error: submitted.error };
  }
  const data = submitted.data || {};
  if (data.status && data.status !== 'success') {
    return { isPam: false, error: null };
  }
  const rows = client.extractRecords(data);
  return { isPam: Array.isArray(rows) && rows.length > 0, error: null };
}

/**
 * @param {object} result
 * @param {number} limit
 */
export function parseSearchFolders(client, result, limit = 10) {
  const data = client.extractRecords(result);
  const folders = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const uid = item.uid || item.folder_uid || '';
    const name = item.name || item.title || item.folder_title || 'Untitled Folder';
    let folderType = item.type || item.folder_type || 'shared_folder';
    folderType = String(folderType).toLowerCase();
    if (!uid || !name) continue;
    if (folderType && !FOLDER_ITEM_TYPES.has(folderType) && folderType !== 'record') {
 // Skip obvious records from mixed search payloads
      if (item.record_type || item.title) continue;
    }
    if (folderType === 'record') continue;
    if (!FOLDER_ITEM_TYPES.has(folderType)) {
      folderType = 'shared_folder';
    }
    folders.push(
      new KeeperFolder({
        uid,
        name,
        folderType,
        isNsf: folderIsNsf(folderType),
      }),
    );
    if (folders.length >= limit) break;
  }
  return folders;
}

