/**
 * Shared enums and data models for approval workflow.
 */

export const RequestType = Object.freeze({
  RECORD: 'record',
  FOLDER: 'folder',
  ONE_TIME_SHARE: 'one_time_share',
});

export const PermissionLevel = Object.freeze({
 // Record permissions
  VIEW_ONLY: 'view_only',
  CAN_EDIT: 'can_edit',
  CAN_SHARE: 'can_share',
  EDIT_AND_SHARE: 'edit_and_share',
  CHANGE_OWNER: 'change_owner',
 // Classic folder permissions
  NO_PERMISSIONS: 'no_permissions',
  MANAGE_USERS: 'manage_users',
  MANAGE_RECORDS: 'manage_records',
  MANAGE_ALL: 'manage_all',
});

/** Nested Share Folder (NSF) role-based permissions. */
export const NSFPermissionRole = Object.freeze({
  VIEWER: 'viewer',
  SHARE_MANAGER: 'share-manager',
  CONTENT_MANAGER: 'content-manager',
  CONTENT_SHARE_MANAGER: 'content-share-manager',
  FULL_MANAGER: 'full-manager',
  TRANSFER_OWNER: 'owner',
});

export const PERMANENT_ONLY_PERMISSIONS = new Set([
  PermissionLevel.CAN_SHARE,
  PermissionLevel.EDIT_AND_SHARE,
  PermissionLevel.CHANGE_OWNER,
]);

/** Classic folder permissions that cannot be time-limited. */
export const PERMANENT_ONLY_FOLDER_PERMISSIONS = new Set([
  PermissionLevel.MANAGE_USERS,
  PermissionLevel.MANAGE_ALL,
]);

/**
 * NSF roles that cannot be time-limited 
 * Only Transfer Ownership is permanent-only; Share Manager / Full Manager
 * honor --expire-in the same as Viewer / Content Manager.
 */
export const PERMANENT_ONLY_NSF_ROLES = new Set([
  NSFPermissionRole.TRANSFER_OWNER,
]);

/**
 * Whether the selected permission ignores duration 
 * @param {string} permission
 * @param {{ forFolder?: boolean, isNsf?: boolean, forOneTimeShare?: boolean }} [options]
 */
export function isPermanentOnlyPermission(permission, options = {}) {
  const { forFolder = false, isNsf = false, forOneTimeShare = false } = options;
  if (!permission || forOneTimeShare) return false;
  if (isNsf) return PERMANENT_ONLY_NSF_ROLES.has(permission);
  if (forFolder) return PERMANENT_ONLY_FOLDER_PERMISSIONS.has(permission);
  return PERMANENT_ONLY_PERMISSIONS.has(permission);
}

/** Folder type strings returned by Commander search / get-folder. */
export const FOLDER_ITEM_TYPES = new Set([
  'shared_folder',
  'nested_share_folder',
  'user_folder',
  'folder',
]);

export function isFolderItemType(itemType) {
  return FOLDER_ITEM_TYPES.has(String(itemType || '').trim().toLowerCase());
}

const NSF_VALUE_SUFFIX = '|nsf';

/**
 * Encode search selection value with NSF flag + type 
 * Format: `uid|nsf|pamUser` or `uid|classic|login` or `uid|classic|shared_folder`
 * @param {string} uid
 * @param {boolean} isNsf
 * @param {string} [itemType]
 */
export function encodeSearchItemValue(uid, isNsf, itemType = '') {
  const flag = isNsf ? 'nsf' : 'classic';
  const type = encodeURIComponent(String(itemType || ''));
  return `${uid}|${flag}|${type}`;
}

/**
 * @param {string} value
 * @returns {[string, boolean, string]} uid, isNsf, itemType
 */
export function decodeSearchItemValue(value) {
  const raw = String(value || '');
  const parts = raw.split('|');
  if (parts.length >= 2 && (parts[1] === 'nsf' || parts[1] === 'classic')) {
    return [parts[0], parts[1] === 'nsf', decodeURIComponent(parts[2] || '')];
  }
 // Legacy: uid|nsf or bare uid
  if (raw.endsWith(NSF_VALUE_SUFFIX)) {
    return [raw.slice(0, -NSF_VALUE_SUFFIX.length), true, ''];
  }
  return [raw, false, ''];
}

/**
 * Map classic record/folder permission to closest NSF role.
 * @param {string} permission
 */
export function classicPermissionToNsfRole(permission) {
  switch (permission) {
    case PermissionLevel.CAN_EDIT:
    case PermissionLevel.MANAGE_RECORDS:
      return NSFPermissionRole.CONTENT_MANAGER;
    case PermissionLevel.CAN_SHARE:
    case PermissionLevel.MANAGE_USERS:
      return NSFPermissionRole.SHARE_MANAGER;
    case PermissionLevel.EDIT_AND_SHARE:
    case PermissionLevel.MANAGE_ALL:
      return NSFPermissionRole.CONTENT_SHARE_MANAGER;
    case PermissionLevel.CHANGE_OWNER:
      return NSFPermissionRole.TRANSFER_OWNER;
    case PermissionLevel.VIEW_ONLY:
    case PermissionLevel.NO_PERMISSIONS:
    default:
      return NSFPermissionRole.VIEWER;
  }
}

export class ApprovalActionData {
  /**
 * @param {object} fields
 */
  constructor({
    approvalId,
    requesterUserName,
    requesterEmail,
    requesterDisplayName = '',
    identifier,
    isUid,
    requestType = RequestType.RECORD,
    justification,
    duration = '1h',
    isNsf = false,
    recordType = '',
    createSelfDestruct = false,
    selfDestructDuration = '5m',
    newlyCreatedUid = '',
    newlyCreatedTitle = '',
    isPamFolder = false,
  }) {
    this.approvalId = approvalId;
    this.requesterUserName = requesterUserName;
    this.requesterEmail = requesterEmail;
    this.requesterDisplayName = requesterDisplayName || requesterEmail || '';
    this.identifier = identifier;
    this.isUid = Boolean(isUid);
    this.requestType = requestType || RequestType.RECORD;
    this.justification = justification;
    this.duration = duration;
    this.isNsf = Boolean(isNsf);
    this.recordType = recordType || '';
    this.createSelfDestruct = Boolean(createSelfDestruct);
    this.selfDestructDuration = selfDestructDuration || '5m';
    this.newlyCreatedUid = newlyCreatedUid || '';
    this.newlyCreatedTitle = newlyCreatedTitle || '';
    this.isPamFolder = Boolean(isPamFolder);
  }

  /** Display label for cards — prefer human name over email. */
  get requesterLabel() {
    return this.requesterDisplayName || this.requesterEmail || 'Unknown';
  }

  get isFolderRequest() {
    return this.requestType === RequestType.FOLDER;
  }

  get isOneTimeShareRequest() {
    return this.requestType === RequestType.ONE_TIME_SHARE;
  }

  toParameters() {
    return [
      { key: 'approval_id', value: this.approvalId },
      { key: 'requester_user_name', value: this.requesterUserName },
      { key: 'requester_email', value: this.requesterEmail },
      { key: 'requester_display_name', value: this.requesterDisplayName },
      { key: 'identifier', value: this.identifier },
      { key: 'is_uid', value: String(this.isUid).toLowerCase() },
      { key: 'request_type', value: this.requestType },
 // Short alias — survives Chat add-on parameter quirks better
      { key: 'rt', value: requestTypeAlias(this.requestType) },
      { key: 'justification', value: this.justification },
      { key: 'duration', value: this.duration },
      { key: 'is_nsf', value: String(this.isNsf).toLowerCase() },
      { key: 'record_type', value: this.recordType },
      {
        key: 'create_self_destruct',
        value: String(this.createSelfDestruct).toLowerCase(),
      },
      { key: 'self_destruct_duration', value: this.selfDestructDuration },
      { key: 'newly_created_uid', value: this.newlyCreatedUid },
      { key: 'newly_created_title', value: this.newlyCreatedTitle },
      { key: 'is_pam_folder', value: String(this.isPamFolder).toLowerCase() },
    ];
  }

  static fromParameters(parameters = []) {
    const data = Object.fromEntries(
      parameters.map((p) => [p.key, p.value ?? '']),
    );
    let requestType = data.request_type || '';
    if (!requestType) {
      requestType = requestTypeFromAlias(data.rt);
    }
    return new ApprovalActionData({
      approvalId: data.approval_id || '',
      requesterUserName: data.requester_user_name || '',
      requesterEmail: data.requester_email || '',
      requesterDisplayName: data.requester_display_name || data.requester_email || '',
      identifier: data.identifier || '',
      isUid: String(data.is_uid || 'true').toLowerCase() === 'true',
      requestType,
      justification: data.justification || '',
      duration: data.duration || '1h',
      isNsf: String(data.is_nsf || 'false').toLowerCase() === 'true',
      recordType: data.record_type || '',
      createSelfDestruct:
        String(data.create_self_destruct || 'false').toLowerCase() === 'true',
      selfDestructDuration: data.self_destruct_duration || '5m',
      newlyCreatedUid: data.newly_created_uid || '',
      newlyCreatedTitle: data.newly_created_title || '',
      isPamFolder: String(data.is_pam_folder || 'false').toLowerCase() === 'true',
    });
  }
}

function requestTypeAlias(requestType) {
  if (requestType === RequestType.FOLDER) return 'f';
  if (requestType === RequestType.ONE_TIME_SHARE) return 'o';
  return 'r';
}

function requestTypeFromAlias(alias) {
  if (alias === 'f') return RequestType.FOLDER;
  if (alias === 'o') return RequestType.ONE_TIME_SHARE;
  return RequestType.RECORD;
}

export class KeeperRecord {
  constructor({ uid, title, recordType, notes = null, isNsf = false }) {
    this.uid = uid;
    this.title = title;
    this.recordType = recordType;
    this.notes = notes;
    this.isNsf = Boolean(isNsf);
  }
}

export class KeeperFolder {
  constructor({
    uid,
    name,
    folderType = 'shared_folder',
    parentUid = null,
    isNsf = false,
  }) {
    this.uid = uid;
    this.name = name;
    this.folderType = folderType || 'shared_folder';
    this.parentUid = parentUid;
    this.isNsf = Boolean(isNsf);
  }
}

/**
 * Normalize Commander EPM info maps.
 * Live Commander (`epm approval view` / list) returns objects.
 * Older payloads used arrays of `Key=Value` strings.
 * @param {unknown} info
 * @returns {Record<string, string>}
 */
function epmInfoMap(info) {
  if (!info) return {};
  if (!Array.isArray(info) && typeof info === 'object') {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(info)) {
      if (value == null) continue;
      out[key] = String(value);
    }
    return out;
  }
  if (!Array.isArray(info)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const item of info) {
    const raw = String(item);
    const i = raw.indexOf('=');
    if (i === -1) continue;
    out[raw.slice(0, i)] = raw.slice(i + 1);
  }
  return out;
}

/**
 * @param {Record<string, string>} map
 * @param {string} key
 */
function epmInfoValue(map, key) {
  if (map[key] != null && map[key] !== '') return map[key];
  const found = Object.keys(map).find((k) => k.toLowerCase() === key.toLowerCase());
  return found ? map[found] : '';
}

/**
 * EPM elevation approval request.
 */
export class EpmRequest {
  /**
 * @param {object} fields
 */
  constructor({
    approvalUid = '',
    approvalType = '',
    status = 'Pending',
    agentUid = '',
    username = '',
    command = '',
    fileName = '',
    filePath = '',
    description = '',
    justification = '',
    expireIn = 30,
    created = '',
  }) {
    this.approvalUid = approvalUid;
    this.approvalType = approvalType;
    this.status = status;
    this.agentUid = agentUid;
    this.username = username;
    this.command = command;
    this.fileName = fileName;
    this.filePath = filePath;
    this.description = description;
    this.justification = justification;
    this.expireIn = Number.isFinite(Number(expireIn)) ? Number(expireIn) : 30;
    this.created = created;
  }

  /**
   * Parse Commander `epm approval list` / `epm approval view` JSON item.
   * `account_info` and `application_info` may be objects (`{ CommandLine: "..." }`)
   * or legacy arrays of `Key=Value` strings.
   * @param {object} data
   */
  static fromDict(data = {}) {
    const account = epmInfoMap(data.account_info);
    const application = epmInfoMap(data.application_info);
    const username = epmInfoValue(account, 'Username');
    const description = epmInfoValue(application, 'Description');
    const fileName = epmInfoValue(application, 'FileName');
    const filePath = epmInfoValue(application, 'FilePath');
    const command = epmInfoValue(application, 'CommandLine');

    let justificationText = '';
    const rawJustification = data.justification || '';
    if (rawJustification) {
      try {
        const parsed = JSON.parse(rawJustification);
        justificationText =
          parsed && typeof parsed === 'object'
            ? String(parsed.text || '')
            : String(rawJustification);
      } catch {
        justificationText = String(rawJustification);
      }
    }

    return new EpmRequest({
      approvalUid: data.approval_uid || '',
      approvalType: data.approval_type || '',
      status: data.status || 'Pending',
      agentUid: data.agent_uid || '',
      username,
      command,
      fileName,
      filePath,
      description,
      justification: justificationText,
      expireIn: data.expire_in ?? 30,
      created: data.created || '',
    });
  }
}
