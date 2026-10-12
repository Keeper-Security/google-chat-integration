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
 * Create a one-time share link 
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
 * Write-capable "Permissions" labels from `share-report -f --format=json`
 * for classic Shared Folders. Commander's own report builder has a literal
 * typo for the records-only label — "Cam Manage Records" (not "Can") — see
 * ShareReportCommand.get_share_info() in Keeper Commander. Matching the
 * typo is required or classic folders shared with only record-management
 * (not user-management) rights are missed.
 */
const SHARED_FOLDER_WRITE_PERMISSIONS = new Set([
  'Cam Manage Records',
  'Can Manage Users & Records',
]);

/** Write-capable "Permissions" labels for Nested Share Folders. */
const NSF_WRITE_PERMISSIONS = new Set([
  'Content Manager',
  'Content and Share Manager',
  'Full Manager',
]);

/**
 * Whether a share-report row's permission label grants write access
 * (ability to add/manage records) rather than view-only or
 * sharing-management-only access.
 * @param {string} folderType - the row's "Type" field
 * @param {string} permissions - the row's "Permissions" field
 */
function hasWritePermission(folderType, permissions) {
  const perm = String(permissions || '').trim();
  const isNsf = String(folderType || '').trim().toLowerCase() === 'nested share folder';
  return isNsf
    ? NSF_WRITE_PERMISSIONS.has(perm)
    : SHARED_FOLDER_WRITE_PERMISSIONS.has(perm);
}

/**
 * Prefix share-report puts on a team member's row with --show-team-users.
 * The member gets the team's permission on the folder.
 */
const TEAM_USER_PREFIX = '(team user) ';

/**
 * Single parse of `share-report -f -tu --format=json` scoped to one user.
 * -tu expands team shares into one row per member, so access through a
 * team counts. Commander can only expand teams when the bot account can
 * see enterprise team membership; otherwise team access is not counted.
 * @param {import('./client.js').KeeperClient} client
 * @param {string} userEmail
 * @returns {Promise<{ folders: Array<{uid:string,name:string,type:string,is_nsf:boolean}>, writableUids: Set<string> }>}
 */
async function fetchUserShareInfo(client, userEmail) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!email) return { folders: [], writableUids: new Set() };

  const submitted = await client.executeCommandSafe(
    'share-report -f -tu --format=json',
    30000,
  );
  if (!submitted.ok) {
    client.logger.error({ err: submitted.error }, 'share-report failed');
    return { folders: [], writableUids: new Set() };
  }

  const resultData = submitted.data || {};
  if (resultData.status === 'error') {
    client.logger.error(
      { message: resultData.message },
      'share-report returned error',
    );
    return { folders: [], writableUids: new Set() };
  }

  const rows = client.extractRecords(resultData);
  const seen = new Set();
  const folders = [];
  const writableUids = new Set();

  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    let sharedTo = String(item['Shared To'] || item.shared_to || '').trim().toLowerCase();
    if (sharedTo.startsWith(TEAM_USER_PREFIX)) {
      sharedTo = sharedTo.slice(TEAM_USER_PREFIX.length).trim();
    }
    if (sharedTo !== email) continue;

    const uid = String(item['Folder UID'] || item.folder_uid || item.uid || '');
    const name = String(item['Folder Name'] || item.folder_name || item.name || '');
    const folderType = String(item.Type || item.type || 'Shared Folder');
    const permissions = String(item.Permissions || item.permissions || '');
    const isNsf = folderType.trim().toLowerCase() === 'nested share folder';
    if (!uid || !name) continue;

    if (hasWritePermission(folderType, permissions)) {
      writableUids.add(uid);
    }

    if (seen.has(uid)) continue;
    seen.add(uid);
    folders.push({
      uid,
      name,
      type: folderType,
      is_nsf: isNsf,
    });
  }

  return { folders, writableUids };
}

/**
 * Shared folders a user can create records in — filtered to those where
 * share-report reports write-level permission (Can Manage Records /
 * Content Manager or above), not merely "shared with them in some
 * capacity". KGC-26-01 fix: a folder the user can only view is no longer
 * offered as a create-secret destination.
 * @param {string} userEmail
 * @returns {Promise<Array<{ uid: string, name: string, type: string, is_nsf: boolean }>>}
 */
export async function getUserSharedFolders(client, userEmail) {
  const { folders } = await getUserShareInfo(client, userEmail);
  client.logger.debug(
    { count: folders.length, email: userEmail },
    'Retrieved user shared folders with write access',
  );
  return folders;
}

/**
 * Both the write-access folder list and UID set in a single share-report
 * round trip — for call sites that need both (e.g. rendering a folder
 * picker and immediately validating the selection), avoiding a duplicate
 * Commander call.
 * @param {string} userEmail
 * @returns {Promise<{ folders: Array<{uid:string,name:string,type:string,is_nsf:boolean}>, writableUids: Set<string> }>}
 */
export async function getUserShareInfo(client, userEmail) {
  const { folders, writableUids } = await fetchUserShareInfo(client, userEmail);
  const writableFolders = folders.filter((f) => writableUids.has(f.uid));
  return { folders: writableFolders, writableUids };
}

/**
 * Subfolders inside a shared folder via `tree -s -v <uid>`.
 * share-report only lists top-level shared folders, never their subfolders,
 * so this does not filter by write access. Access to a subfolder comes from
 * its shared folder: callers must check the user can write to
 * sharedFolderUid (getUserShareInfo) and that a chosen subfolder is in this
 * list.
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
    const rawType = String(
      item.type || item.folder_type || item.folderType || item.node_type || '',
    ).toLowerCase();
    const isNsf =
      rawType.includes('nested') ||
      rawType.includes('nsf') ||
      name.toLowerCase().includes('[nested share folder]') ||
      path.toLowerCase().includes('[nested share folder]');
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
 * One folder's metadata via `get <uid> --format=json`. Used to check a
 * create-secret target on submit: `tree` output is text, and Service Mode
 * can read the wrong UID from it when a folder name contains parentheses.
 * `get` falls back to matching by title, so anything other than an exact
 * folder_uid match returns null.
 * @param {string} folderUid
 * @returns {Promise<{ uid: string, name: string, path: string, is_nsf: boolean, shared_folder_uid: string|null }|null>}
 */
export async function getFolderInfo(client, folderUid) {
  const uid = String(folderUid || '').trim();
  if (!uid) return null;

  const submitted = await client.executeCommandSafe(
    `get ${shellQuote(uid)} --format=json`,
    15000,
  );
  if (!submitted.ok) {
    client.logger.warn({ err: submitted.error, folderUid: uid }, 'get folder failed');
    return null;
  }

  const resultData = submitted.data || {};
  const data = resultData.data;
  if (resultData.status === 'error' || !data || typeof data !== 'object') return null;
  if (String(data.folder_uid || '') !== uid) return null;

  const type = String(data.type || '');
  if (type !== 'classic_folder' && type !== 'nested_share_folder') return null;

  return {
    uid,
    name: String(data.name || ''),
    path: String(data.path || ''),
    is_nsf: type === 'nested_share_folder',
    shared_folder_uid: data.shared_folder_uid ? String(data.shared_folder_uid) : null,
  };
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

