/**
 * Offline end-to-end test without Google Cloud Pub/Sub.
 */

import { KeeperGoogleChatApp } from '../src/app.js';
import { buildDeviceApprovalCard, formatDeviceRequestDate } from '../src/lib/cards/device.js';
import { buildEpmApprovalCard } from '../src/lib/cards/epm.js';
import {
  buildConfigFromData,
  loadConfigSync,
} from '../src/lib/config.js';
import {
  extractFieldValue,
  mapCommanderRecord,
  mapGchatRecord,
  mergeConfigSections,
} from '../src/lib/ksm_utils.js';
import {
  grantNsfFolderAccess,
  grantNsfRecordAccess,
  nsfExpireInFlags,
} from '../src/lib/keeper/grants.js';
import { createLogger, getLogger } from '../src/lib/logger.js';
import { KeeperFolder, KeeperRecord, EpmRequest } from '../src/lib/models.js';
import {
  formatAdminConsoleTimestamp,
  sanitizeHyperlinks,
} from '../src/lib/utils.js';

class MockChatClient {
  constructor() {
    this.messages = [];
    this.dms = [];
    this.patches = [];
  }

  async postMessage({
    parent,
    message,
    threadName = null,
    privateViewer = null,
    space = null,
    preferInPlace = false,
  }) {
    // Mirror production: private replies → bot DM unless preferInPlace.
    if (privateViewer && !preferInPlace) {
      return this.sendDm(
        privateViewer,
        message.text || '',
        message.cardsV2 || null,
      );
    }

    const entry = {
      parent,
      message,
      thread: threadName,
      privateViewer,
      space,
      preferInPlace,
    };
    this.messages.push(entry);
    console.log('\n--- CHAT POST ---');
    console.log(`parent: ${parent}`);
    if (privateViewer) console.log(`private to: ${privateViewer}${preferInPlace ? ' (in-place)' : ''}`);
    console.log(`text: ${(message.text || '').slice(0, 500)}`);
    if (message.cardsV2) console.log('cardsV2: approval card posted');
    return entry;
  }

  async patchMessage(messageName, message) {
    this.patches.push({ messageName, message });
    console.log('\n--- CHAT PATCH ---');
    console.log(`message: ${messageName}`);
    console.log(`text: ${message.text || ''}`);
    return message;
  }

  async sendDm(userName, text, cardsV2 = null) {
    this.dms.push({ userName, text, cardsV2 });
    console.log('\n--- CHAT DM ---');
    console.log(`to: ${userName}`);
    console.log(`text: ${(text || '').slice(0, 500)}`);
    if (cardsV2) console.log('cardsV2: notification card');
    return { parent: `spaces/DM_${userName}`, message: { text, cardsV2 } };
  }
}

/**
 * Offline stub of KeeperClient — returns sample records so the request →
 * search → approve flow can be exercised without a live Commander.
 * Production code (src/lib/keeper/) contains no mock data.
 */
class MockKeeperClient {
  async healthCheck() {
    return true;
  }

  /** stub: production uses Commander `server` command. */
  async getServerDomain() {
    return 'keepersecurity.com';
  }

  async searchRecords(query, limit = 10, options = {}) {
    const forOneTimeShare = Boolean(options.forOneTimeShare);
    const records = [
      new KeeperRecord({
        uid: 'kR3cF9Xm2Lp8NqT1uV6w',
        title: 'AWS Test Credentials',
        recordType: 'login',
        notes: 'Sample result 1',
      }),
      new KeeperRecord({
        uid: 'xY7mN2pQ9Rw4Kj5LvB8a',
        title: 'AWS Staging DB',
        recordType: 'databaseCredentials',
        notes: 'Sample result 2',
      }),
      new KeeperRecord({
        uid: 'nsfMockNestedShare01abcd',
        title: 'NSF Nested Creds',
        recordType: 'login',
        notes: 'Sample NSF result',
        isNsf: true,
      }),
      new KeeperRecord({
        uid: 'pamMockUserRecord01abcdef',
        title: 'PAM Demo User',
        recordType: 'pamUser',
        notes: 'Sample PAM user',
      }),
    ].filter((r) => {
      if (forOneTimeShare && (r.isNsf || String(r.recordType).toLowerCase().includes('pam'))) {
        return false;
      }
      const q = String(query || '').toLowerCase();
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.uid.toLowerCase().includes(q) ||
        q.includes('test') ||
        q.includes('aws') ||
        q.includes('pam') ||
        q.includes('nsf')
      );
    });
    return { records: records.slice(0, limit), error: null };
  }

  async getRecordByUid(uid) {
    const isPam = String(uid).startsWith('pam');
    const isNsf = String(uid).startsWith('nsf');
    return new KeeperRecord({
      uid,
      title: isPam ? 'Demo PAM User' : isNsf ? 'Demo NSF Record' : 'Demo Production Database',
      recordType: isPam ? 'pamUser' : 'login',
      notes: 'Sample record for offline testing',
      isNsf,
    });
  }

  async getRecordOwner(uid) {
 // UID containing "owned" simulates requester-owned records.
    if (String(uid).toLowerCase().includes('owned')) {
      return 'requester@example.com';
    }
    return null;
  }

  async grantRecordAccess({ permission, durationSeconds = null, rotateOnExpire = false, isNsf = false, recordUid = '', userEmail = '' }) {
    if (
      String(recordUid).toLowerCase().includes('owned') &&
      String(userEmail).toLowerCase() === 'requester@example.com'
    ) {
      return {
        success: false,
        error_code: 'record_owner',
        error:
          `Cannot grant access to record owner (${userEmail}). ` +
          'The user already owns this record and has access to it.',
      };
    }
    const expiresAt =
      durationSeconds == null
        ? 'Never (Permanent)'
        : new Date(Date.now() + durationSeconds * 1000).toISOString();
    return {
      success: true,
      expires_at: expiresAt,
      permission,
      rotate_on_expire: Boolean(rotateOnExpire && durationSeconds != null),
      invitation_sent: false,
      is_nsf: isNsf,
    };
  }

  async createRecord({ title, selfDestructDuration = null, folderUid = null }) {
    return {
      success: true,
      record_uid: 'newClassicRecordUid01234',
      title,
      self_destruct: Boolean(selfDestructDuration),
      self_destruct_duration: selfDestructDuration,
      is_nsf: false,
      folder_uid: folderUid,
    };
  }

  async createNsfRecord({ title, folderUid = null }) {
    return {
      success: true,
      record_uid: 'newNsfRecordUidAbcdef012',
      title,
      is_nsf: true,
      folder_uid: folderUid,
    };
  }

  async getUserSharedFolders(userEmail) {
    if (!userEmail) return [];
    return [
      {
        uid: 'sharedFolderClassicUid01',
        name: 'Engineering Creds',
        type: 'Shared Folder',
        is_nsf: false,
      },
      {
        uid: 'sharedFolderNsfUid012345',
        name: 'NSF Team Vault',
        type: 'Nested Share Folder',
        is_nsf: true,
      },
    ];
  }

  async listSubfolders(sharedFolderUid) {
    if (sharedFolderUid === 'sharedFolderClassicUid01') {
      return [
        {
          uid: 'subfolderClassicUid0123',
          name: 'Prod',
          path: 'Engineering Creds / Prod',
          level: 1,
          type: 'folder',
          is_nsf: false,
        },
      ];
    }
    return [];
  }

  async syncDown() {
    return { success: true, error: null };
  }

  async searchFolders(query, limit = 10) {
    const folders = [
      new KeeperFolder({
        uid: 'folderClassicUid012345',
        name: 'Engineering Creds',
        folderType: 'shared_folder',
        isNsf: false,
      }),
      new KeeperFolder({
        uid: 'folderNsfUid0123456789ab',
        name: 'NSF Team Folder',
        folderType: 'nested_share_folder',
        isNsf: true,
      }),
      new KeeperFolder({
        uid: 'folderPamUid0123456789ab',
        name: 'PAM User Folder',
        folderType: 'shared_folder',
        isNsf: false,
      }),
    ].filter((f) => {
      const q = String(query || '').toLowerCase();
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.uid.toLowerCase().includes(q) ||
        q.includes('eng') ||
        q.includes('folder') ||
        q.includes('pam') ||
        q.includes('nsf')
      );
    });
    return { folders: folders.slice(0, limit), error: null };
  }

  async getFolderByUid(uid) {
    if (String(uid).includes('record')) {
      return new KeeperFolder({
        uid,
        name: 'Looks like a record',
        folderType: 'record',
        isNsf: false,
      });
    }
    const isNsf = String(uid).toLowerCase().includes('nsf');
    const isPam = String(uid).toLowerCase().includes('pam');
    return new KeeperFolder({
      uid,
      name: isPam ? 'PAM User Folder' : isNsf ? 'NSF Team Folder' : 'Engineering Creds',
      folderType: isNsf ? 'nested_share_folder' : 'shared_folder',
      isNsf,
    });
  }

  async isPamUserFolder(folderUid) {
    return {
      isPam: String(folderUid || '').toLowerCase().includes('pam'),
      error: null,
    };
  }

  async grantFolderAccess({ permission, durationSeconds = null, rotateOnExpire = false }) {
    return {
      success: true,
      expires_at:
        durationSeconds == null
          ? 'Never (Permanent)'
          : new Date(Date.now() + durationSeconds * 1000).toISOString(),
      permission,
      rotate_on_expire: Boolean(rotateOnExpire && durationSeconds != null),
      invitation_sent: false,
    };
  }

  async grantNsfFolderAccess({ role, durationSeconds = null }) {
    return {
      success: true,
      expires_at:
        durationSeconds == null
          ? 'Never (Permanent)'
          : new Date(Date.now() + durationSeconds * 1000).toISOString(),
      permission: role,
      is_nsf: true,
      invitation_sent: false,
    };
  }

  async createOneTimeShare({ recordUid, durationSeconds = 300, editable = false }) {
    return {
      success: true,
      share_url: `https://keepersecurity.com/vault/sharemock/${recordUid}`,
      expires_at:
        durationSeconds == null
          ? 'Never (7 days default)'
          : new Date(Date.now() + durationSeconds * 1000).toISOString(),
      duration: durationSeconds == null ? '7d' : `${durationSeconds}s`,
      editable: Boolean(editable),
    };
  }

  /**
 * Offline EPM stubs — production uses epm sync-down / approval list|action.
 * @type {object[]|null}
 */
  pendingEpmRequests = [
    {
      approval_uid: 'epmApprovalUid01234567',
      approval_type: 'PrivilegeElevation',
      status: 'Pending',
      agent_uid: 'agentUidMock0123456789ab',
      account_info: ['Username=alice.admin'],
      application_info: [
        'Description=Run elevated installer',
        'FileName=msiexec.exe',
        'FilePath=C:\\Windows\\System32',
        'CommandLine=',
      ],
      justification: JSON.stringify({ text: 'Need to install patch http://evil.example' }),
      expire_in: 30,
      created: '2026-08-10T06:00:00Z',
    },
  ];

  epmActionMode = 'success'; // success | already_processed | error

  async getPendingEpmRequests() {
    return this.pendingEpmRequests;
  }

  async approveEpmRequest(approvalUid) {
    if (this.epmActionMode === 'already_processed') {
      return {
        success: false,
        error: 'Approval request does not exist or cannot be modified',
        already_processed: true,
      };
    }
    if (this.epmActionMode === 'error') {
      return { success: false, error: 'Commander refused EPM approve' };
    }
    return { success: true, approvalUid };
  }

  async denyEpmRequest(approvalUid) {
    if (this.epmActionMode === 'already_processed') {
      return {
        success: false,
        error: 'Approval request does not exist or cannot be modified',
        already_processed: true,
      };
    }
    if (this.epmActionMode === 'error') {
      return { success: false, error: 'Commander refused EPM deny' };
    }
    return { success: true, approvalUid };
  }

  /**
   * Offline Cloud SSO device stubs — production uses device-approve.
   * @type {object[]}
   */
  pendingDeviceApprovals = [
    {
      device_id: 'deviceMockId0123456789ab',
      device_name: 'Alice MacBook',
      device_type: 'DESKTOP',
      client_version: '16.12.0',
      email: 'alice@example.com',
      ip_address: '203.0.113.10',
      date: '2026-08-11 10:00:00',
    },
  ];

  deviceActionMode = 'success'; // success | already_handled | error

  async getPendingDeviceApprovals() {
    return this.pendingDeviceApprovals;
  }

  async approveDevice(deviceId) {
    if (this.deviceActionMode === 'already_handled') {
      return {
        success: false,
        already_handled: true,
        error: 'This device request was already processed',
      };
    }
    if (this.deviceActionMode === 'error') {
      return { success: false, error: 'Commander refused device approve' };
    }
    return { success: true, deviceId };
  }

  async denyDevice(deviceId) {
    if (this.deviceActionMode === 'already_handled') {
      return {
        success: false,
        already_handled: true,
        error: 'This device request was already processed',
      };
    }
    if (this.deviceActionMode === 'error') {
      return { success: false, error: 'Commander refused device deny' };
    }
    return { success: true, deviceId };
  }
}

async function main() {
  createLogger();
  const logger = getLogger();

  const config = loadConfigSync('config.example.yaml');
  config.chat.approvalsSpaceId = 'spaces/APPROVALS_DEMO';

  console.log('\n=== NSF Permanent uses --expire-in never ===');
  if (nsfExpireInFlags(null).join(' ') !== '--expire-in never') {
    throw new Error(
      `Expected permanent NSF flags "--expire-in never", got ${nsfExpireInFlags(null)}`,
    );
  }
  if (nsfExpireInFlags(3600).join(' ') !== '--expire-in 1h') {
    throw new Error(
      `Expected timed NSF flags "--expire-in 1h", got ${nsfExpireInFlags(3600)}`,
    );
  }

  const nsfCmds = [];
  const nsfFakeClient = {
    async syncDown() {
      return {};
    },
    async getRecordOwner() {
      return null;
    },
    async executeCommandSafe(command) {
      nsfCmds.push(String(command));
      return { ok: true, data: { status: 'success' } };
    },
  };

  await grantNsfFolderAccess(nsfFakeClient, {
    folderUid: 'nsfFolderUid012345678901',
    userEmail: 'user@example.com',
    role: 'viewer',
    durationSeconds: null,
  });
  const permanentFolderCmd = nsfCmds.find(
    (c) => c.includes('nsf-share-folder') && c.includes('grant'),
  );
  if (!permanentFolderCmd || !permanentFolderCmd.includes('--expire-in never')) {
    throw new Error(
      `Expected nsf-share-folder Permanent to include --expire-in never, got: ${permanentFolderCmd}`,
    );
  }

  nsfCmds.length = 0;
  await grantNsfFolderAccess(nsfFakeClient, {
    folderUid: 'nsfFolderUid012345678901',
    userEmail: 'user@example.com',
    role: 'viewer',
    durationSeconds: 3600,
  });
  const timedFolderCmd = nsfCmds.find(
    (c) => c.includes('nsf-share-folder') && c.includes('grant'),
  );
  if (!timedFolderCmd || !timedFolderCmd.includes('--expire-in 1h')) {
    throw new Error(
      `Expected timed nsf-share-folder to keep --expire-in 1h, got: ${timedFolderCmd}`,
    );
  }
  if (timedFolderCmd.includes('--expire-in never')) {
    throw new Error('Timed NSF folder grant must not send --expire-in never');
  }

  nsfCmds.length = 0;
  await grantNsfRecordAccess(nsfFakeClient, {
    recordUid: 'nsfMockNestedShare01abcd',
    userEmail: 'user@example.com',
    role: 'viewer',
    durationSeconds: null,
  });
  const permanentRecordCmd = nsfCmds.find(
    (c) => c.includes('nsf-share-record') && c.includes('grant'),
  );
  if (!permanentRecordCmd || !permanentRecordCmd.includes('--expire-in never')) {
    throw new Error(
      `Expected nsf-share-record Permanent to include --expire-in never, got: ${permanentRecordCmd}`,
    );
  }

  console.log('NSF --expire-in never checks passed.');

  console.log('\n=== KSM field mapping (offline) ===');
  const fakeCommanderRecord = {
    data: {
      fields: [],
      custom: [
        { type: 'text', label: 'service_url', value: ['http://localhost:8900/api/v2/'] },
        { type: 'text', label: 'api_key', value: ['test-api-key'] },
      ],
    },
  };
  const commanderMapped = mapCommanderRecord(fakeCommanderRecord);
  if (commanderMapped.keeper?.api_key !== 'test-api-key') {
    throw new Error('Expected COMMANDER_RECORD api_key mapping');
  }

  const saJson = JSON.stringify({
    type: 'service_account',
    project_id: 'ksm-proj',
    private_key: 'x',
    client_email: 'bot@ksm-proj.iam.gserviceaccount.com',
  });
  const fakeGchatRecord = {
    data: {
      fields: [],
      custom: [
        { type: 'text', label: 'google_service_account_json', value: [saJson] },
        { type: 'text', label: 'google_project_id', value: ['ksm-proj'] },
        { type: 'text', label: 'google_subscription_id', value: ['ksm-sub'] },
        { type: 'text', label: 'google_topic_id', value: ['ksm-topic'] },
        { type: 'text', label: 'chat_approval_space_id', value: ['spaces/KSM'] },
        { type: 'text', label: 'chat_command_request_record_id', value: ['11'] },
        { type: 'text', label: 'chat_command_request_folder_id', value: ['12'] },
        { type: 'text', label: 'chat_command_external_share_id', value: ['13'] },
        { type: 'text', label: 'pedm_enabled', value: ['true'] },
        { type: 'text', label: 'pedm_polling_interval', value: ['90'] },
        { type: 'text', label: 'device_approval_enabled', value: ['true'] },
        { type: 'text', label: 'device_approval_polling_interval', value: ['150'] },
      ],
    },
  };
  if (extractFieldValue(fakeGchatRecord, 'pedm_enabled') !== 'true') {
    throw new Error('Expected extractFieldValue for pedm_enabled');
  }
  const gchatMapped = mapGchatRecord(fakeGchatRecord);
  if (!gchatMapped.google?.credentials_file) {
    throw new Error('Expected google_service_account_json written to credentials_file');
  }
  if (gchatMapped.google.project_id !== 'ksm-proj') {
    throw new Error('Expected google_project_id from KSM');
  }
  if (gchatMapped.chat?.command_external_share_id !== 13) {
    throw new Error(
      `Expected chat_command_external_share_id=13, got ${gchatMapped.chat?.command_external_share_id}`,
    );
  }
  if (gchatMapped.epm?.enabled !== true || gchatMapped.epm?.polling_interval_in_sec !== 90) {
    throw new Error('Expected pedm_* vault fields to map into epm section');
  }
  if (
    gchatMapped.device_approval?.enabled !== true ||
    gchatMapped.device_approval?.polling_interval_in_sec !== 150
  ) {
    throw new Error('Expected device_approval_* mapping from KSM');
  }

  const merged = mergeConfigSections(
    { google: { project_id: 'yaml-proj' }, epm: { enabled: false } },
    gchatMapped,
  );
  const runtime = buildConfigFromData(merged, { ksmLoaded: true });
  if (runtime.google.projectId !== 'ksm-proj') {
    throw new Error('KSM should overlay YAML google.project_id');
  }
  if (runtime.chat.commandOneTimeShareId !== 13) {
    throw new Error('Expected external share command id from KSM');
  }
  if (!runtime.epm.enabled || runtime.epm.pollingIntervalInSec !== 90) {
    throw new Error('Expected EPM enabled from pedm_enabled / pedm_polling_interval');
  }
  // cleanup temp SA file written by mapGchatRecord
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.unlinkSync(gchatMapped.google.credentials_file);
    fs.rmdirSync(path.dirname(gchatMapped.google.credentials_file));
  } catch {
    // ignore
  }
  console.log('KSM field mapping checks passed.');

  const mockChat = new MockChatClient();
  const app = new KeeperGoogleChatApp(config, {
    chatClient: mockChat,
    keeperClient: new MockKeeperClient(),
  });

  const requestEvent = {
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-request-record kR3cF9Xm2Lp8NqT1uV6w Need staging access',
      argumentText: 'kR3cF9Xm2Lp8NqT1uV6w Need staging access',
      slashCommand: { commandId: config.chat.commandRequestRecordId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD' },
    },
  };

  console.log('Step 1: requester submits /keeper-request-record');
  await app.handleEvent(requestEvent);

  console.log('\nStep 1b: same command in Workspace add-on (Pub/Sub) event format');
  const addonEvent = {
    commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
    chat: {
      user: {
        name: 'users/requester',
        email: 'requester@example.com',
        displayName: 'Requester User',
      },
      appCommandPayload: {
        appCommandMetadata: {
          appCommandId: config.chat.commandRequestRecordId,
          appCommandType: 'SLASH_COMMAND',
        },
        space: {
          name: 'spaces/REQUESTER_DM',
          spaceType: 'DIRECT_MESSAGE',
          type: 'DM',
        },
        message: {
          text: '/keeper-request-record kR3cF9Xm2Lp8NqT1uV6w Need staging access',
          argumentText: 'kR3cF9Xm2Lp8NqT1uV6w Need staging access',
        },
      },
    },
  };

  const beforeMessages = mockChat.messages.length;
  const beforeDms = mockChat.dms.length;
  await app.handleEvent(addonEvent);
  if (
    mockChat.messages.length <= beforeMessages &&
    mockChat.dms.length <= beforeDms
  ) {
    throw new Error('Add-on format event was not handled (normalization failed)');
  }

  const approvalPost = mockChat.messages.find(
    (m) => m.parent === config.chat.approvalsSpaceId,
  );
  if (!approvalPost) {
    throw new Error('Expected approval card in approvals space');
  }

  const card = approvalPost.message.cardsV2[0].card;
  const approveButton = card.sections.at(-1).widgets[0].buttonList.buttons[0];
  const params = approveButton.onClick.action.parameters;

  console.log('\nStep 2: approver clicks Approve');
  const approveEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG123' },
    action: {
      actionMethodName: 'approve_request',
      parameters: params,
    },
    common: {
      formInputs: {
        permission: { stringInputs: { value: ['can_edit'] } },
        duration: { stringInputs: { value: ['1h'] } },
      },
    },
  };
  await app.handleEvent(approveEvent);

  logger.info('Local flow completed successfully.');
  console.log('\nLocal flow completed successfully.');

  console.log('\n\n=== DESCRIPTION-BASED FLOW ===');
  console.log('\nStep 3: requester submits description-based request');
  const mockChat2 = new MockChatClient();
  const app2 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat2,
    keeperClient: new MockKeeperClient(),
  });

  const descEvent = {
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-request-record "AWS test" need access for staging',
      argumentText: '"AWS test" need access for staging',
      slashCommand: { commandId: config.chat.commandRequestRecordId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD2' },
    },
  };
  await app2.handleEvent(descEvent);

  const searchApproval = mockChat2.messages.find(
    (m) => m.parent === config.chat.approvalsSpaceId,
  );
  if (!searchApproval) {
    throw new Error('Expected approval card with search button in approvals space');
  }

  const searchCard = searchApproval.message.cardsV2[0].card;
  const searchButton = searchCard.sections.at(-1).widgets[0].buttonList.buttons[0];
  const searchParams = searchButton.onClick.action.parameters;

  console.log('\nStep 4: approver clicks "Search Records"');
  const searchEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG456' },
    action: {
      actionMethodName: 'search_records',
      parameters: searchParams,
    },
    common: { formInputs: {} },
  };
  await app2.handleEvent(searchEvent);

  console.log('\nStep 5: approver selects a record and clicks Approve');
  const approveSearchParams = searchParams.filter((p) => p.key !== '__action');
  const approveSearchEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG456' },
    action: {
      actionMethodName: 'approve_search_result',
      parameters: [
        ...approveSearchParams,
        { key: '__action', value: 'approve_search_result' },
      ],
    },
    common: {
      formInputs: {
        selected_record: { stringInputs: { value: ['kR3cF9Xm2Lp8NqT1uV6w'] } },
        permission: { stringInputs: { value: ['view_only'] } },
        duration: { stringInputs: { value: ['4h'] } },
      },
    },
  };
  await app2.handleEvent(approveSearchEvent);

  console.log('\nDescription-based flow completed successfully.');

  console.log('\n\n=== NSF + PAM ROTATE FLOWS ===');
  const mockChat3 = new MockChatClient();
  const app3 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat3,
    keeperClient: new MockKeeperClient(),
  });

  console.log('\nStep 6: NSF record approve via search result encoding');
  const nsfApproveEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_NSF' },
    action: {
      actionMethodName: 'approve_search_result',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-NSF01' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'identifier', value: 'AWS test' },
        { key: 'is_uid', value: 'false' },
        { key: 'request_type', value: 'record' },
        { key: 'justification', value: 'need nsf access' },
        { key: 'duration', value: '1h' },
        { key: '__action', value: 'approve_search_result' },
      ],
    },
    common: {
      formInputs: {
        selected_record: {
          stringInputs: { value: ['nsfMockNestedShare01abcd|nsf|login'] },
        },
        permission: { stringInputs: { value: ['viewer'] } },
        duration: { stringInputs: { value: ['1h'] } },
      },
    },
  };
  await app3.handleEvent(nsfApproveEvent);

  console.log('\nStep 7: PAM User approve with rotate checkbox');
  const pamApproveEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_PAM' },
    action: {
      actionMethodName: 'approve_request',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-PAM01' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'identifier', value: 'pamMockUserRecord01abcdef' },
        { key: 'is_uid', value: 'true' },
        { key: 'request_type', value: 'record' },
        { key: 'justification', value: 'need pam access' },
        { key: 'duration', value: '1h' },
        { key: 'is_nsf', value: 'false' },
        { key: 'record_type', value: 'pamUser' },
        { key: '__action', value: 'approve_request' },
      ],
    },
    common: {
      formInputs: {
        permission: { stringInputs: { value: ['view_only'] } },
        duration: { stringInputs: { value: ['1h'] } },
        pam_rotate: { stringInputs: { value: ['rotate_on_expire'] } },
      },
    },
  };
  await app3.handleEvent(pamApproveEvent);

  console.log('\nNSF + PAM flows completed successfully.');

  console.log('\n\n=== REFINE SEARCH + BACK FLOWS ===');
  const mockChat4 = new MockChatClient();
  const app4 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat4,
    keeperClient: new MockKeeperClient(),
  });

  console.log('\nStep 8: approver clicks "Refine Search" with a new query');
  const refineSearchEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_REFINE' },
    action: {
      actionMethodName: 'refine_search',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-REFINE01' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'identifier', value: 'AWS test' },
        { key: 'is_uid', value: 'false' },
        { key: 'request_type', value: 'record' },
        { key: 'justification', value: 'need prod access' },
        { key: 'duration', value: '1h' },
        { key: '__action', value: 'refine_search' },
      ],
    },
    common: {
      formInputs: {
        search_query: { stringInputs: { value: ['production database'] } },
      },
    },
  };
  await app4.handleEvent(refineSearchEvent);

  console.log('\nStep 9: approver clicks "← Back" to return to approval card');
  const backEvent = {
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_BACK' },
    action: {
      actionMethodName: 'back_to_approval',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-BACK01' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'identifier', value: 'AWS test' },
        { key: 'is_uid', value: 'false' },
        { key: 'request_type', value: 'record' },
        { key: 'justification', value: 'need prod access' },
        { key: 'duration', value: '1h' },
        { key: '__action', value: 'back_to_approval' },
      ],
    },
    common: { formInputs: {} },
  };
  await app4.handleEvent(backEvent);

  console.log('\nRefine search + back flows completed successfully.');

  console.log('\n\n=== CREATE NEW RECORD FLOWS ===');
  const mockChat5 = new MockChatClient();
  const app5 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat5,
    keeperClient: new MockKeeperClient(),
  });

  const createBaseParams = [
    { key: 'approval_id', value: 'APR-TEST-CREATE01' },
    { key: 'requester_user_name', value: 'users/requester' },
    { key: 'requester_email', value: 'requester@example.com' },
    { key: 'requester_display_name', value: 'Requester User' },
    { key: 'identifier', value: 'new vault login' },
    { key: 'is_uid', value: 'false' },
    { key: 'request_type', value: 'record' },
    { key: 'justification', value: 'need a new record' },
    { key: 'duration', value: '1h' },
  ];

  console.log('\nStep 10: approver opens Create New Record form');
  await app5.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_CREATE' },
    action: {
      actionMethodName: 'create_new_record',
      parameters: [
        ...createBaseParams,
        { key: '__action', value: 'create_new_record' },
      ],
    },
    common: {
      formInputs: {
        search_query: { stringInputs: { value: ['new vault login'] } },
      },
    },
  });

  console.log('\nStep 11: approver submits NSF create (default)');
  await app5.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_CREATE' },
    action: {
      actionMethodName: 'submit_create_record',
      parameters: [
        ...createBaseParams,
        { key: 'create_use_classic', value: 'false' },
        { key: 'create_show_expiration', value: 'false' },
        { key: 'create_original_query', value: 'new vault login' },
        { key: '__action', value: 'submit_create_record' },
      ],
    },
    common: {
      formInputs: {
        record_title: { stringInputs: { value: ['Created NSF Login'] } },
        record_login: { stringInputs: { value: ['user@example.com'] } },
        auto_gen_password: { stringInputs: { value: ['auto_gen'] } },
      },
    },
  });

  console.log('\nStep 12: approver creates Classic self-destruct record');
  await app5.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_CREATE_SD' },
    action: {
      actionMethodName: 'submit_create_record',
      parameters: [
        ...createBaseParams,
        { key: 'approval_id', value: 'APR-TEST-CREATE-SD' },
        { key: 'create_use_classic', value: 'true' },
        { key: 'create_show_expiration', value: 'true' },
        { key: 'create_original_query', value: 'temp secret' },
        { key: '__action', value: 'submit_create_record' },
      ],
    },
    common: {
      formInputs: {
        classic_vault: { stringInputs: { value: ['classic'] } },
        self_destructive: { stringInputs: { value: ['enabled'] } },
        link_expiration: { stringInputs: { value: ['30m'] } },
        record_title: { stringInputs: { value: ['Temp Secret'] } },
        record_login: { stringInputs: { value: ['temp-user'] } },
        auto_gen_password: { stringInputs: { value: ['auto_gen'] } },
      },
    },
  });

  console.log('\nCreate new record flows completed successfully.');

  console.log('\n=== Folder request flow ===');
  const mockChat6 = new MockChatClient();
  const app6 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat6,
    keeperClient: new MockKeeperClient(),
  });

  console.log('\nStep 13: requester submits /keeper-request-folder by UID');
  await app6.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-request-folder folderClassicUid012345 Need folder access',
      argumentText: 'folderClassicUid012345 Need folder access',
      slashCommand: { commandId: config.chat.commandRequestFolderId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD_FOLDER' },
    },
  });

  const folderApproval = mockChat6.messages.find(
    (m) => m.parent === 'spaces/APPROVALS_DEMO',
  );
  if (!folderApproval) {
    throw new Error('Expected folder approval card in approvals space');
  }

  const folderParams = [
    { key: 'approval_id', value: 'APR-TEST-FOLDER' },
    { key: 'requester_user_name', value: 'users/requester' },
    { key: 'requester_email', value: 'requester@example.com' },
    { key: 'requester_display_name', value: 'Requester User' },
    { key: 'identifier', value: 'Engineering Creds' },
    { key: 'is_uid', value: 'false' },
    { key: 'request_type', value: 'folder' },
    { key: 'justification', value: 'Need folder access' },
    { key: 'duration', value: '5m' },
    { key: 'is_nsf', value: 'false' },
    { key: 'record_type', value: '' },
    { key: 'is_pam_folder', value: 'false' },
  ];

  console.log('\nStep 14: description-based folder request + search + approve');
  const mockChat7 = new MockChatClient();
  const app7 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat7,
    keeperClient: new MockKeeperClient(),
  });

  await app7.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-request-folder "Engineering Creds" Need folder access',
      argumentText: '"Engineering Creds" Need folder access',
      slashCommand: { commandId: config.chat.commandRequestFolderId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD_FOLDER2' },
    },
  });

  await app7.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_FOLDER_SEARCH' },
    action: {
      actionMethodName: 'search_folders',
      parameters: [
        ...folderParams,
        { key: '__action', value: 'search_folders' },
      ],
    },
    common: { formInputs: {} },
  });

  await app7.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_FOLDER_APPROVE' },
    action: {
 // Folder-suffixed method must force folder grant even if request_type is missing
      actionMethodName: 'approve_search_result_folders',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-FOLDER' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'requester_display_name', value: 'Requester User' },
        { key: 'identifier', value: 'Engineering Creds' },
        { key: 'is_uid', value: 'false' },
 // intentionally omit request_type to prove method-name routing
        { key: 'justification', value: 'Need folder access' },
        { key: 'duration', value: '5m' },
        { key: 'is_nsf', value: 'false' },
        { key: '__action', value: 'approve_search_result_folders' },
      ],
    },
    common: {
      formInputs: {
        selected_record: {
          stringInputs: {
            value: ['folderClassicUid012345|classic|shared_folder'],
          },
        },
        permission: { stringInputs: { value: ['no_permissions'] } },
        duration: { stringInputs: { value: ['5m'] } },
      },
    },
  });

  console.log('\nFolder request flows completed successfully.');

  console.log('\n=== One-time share flow ===');
  const mockChat8 = new MockChatClient();
  const app8 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat8,
    keeperClient: new MockKeeperClient(),
  });

  console.log('\nStep 15: requester submits /keeper-external-share by UID');
  await app8.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-external-share kR3cF9Xm2Lp8NqT1uV6w Need temporary share link',
      argumentText: 'kR3cF9Xm2Lp8NqT1uV6w Need temporary share link',
      slashCommand: { commandId: config.chat.commandOneTimeShareId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD_OTS' },
    },
  });

  const otsApproval = mockChat8.messages.find(
    (m) => m.parent === 'spaces/APPROVALS_DEMO',
  );
  if (!otsApproval) {
    throw new Error('Expected OTS approval card in approvals space');
  }

  console.log('\nStep 16: description-based OTS request + search + approve');
  const mockChat9 = new MockChatClient();
  const mockKeeper9 = new MockKeeperClient();
  const app9 = new KeeperGoogleChatApp(config, {
    chatClient: mockChat9,
    keeperClient: mockKeeper9,
  });

  await app9.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-external-share "AWS Test" Need temporary share link',
      argumentText: '"AWS Test" Need temporary share link',
      slashCommand: { commandId: config.chat.commandOneTimeShareId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD_OTS2' },
    },
  });

  await app9.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_OTS_SEARCH' },
    action: {
      actionMethodName: 'search_ots',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-OTS' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'requester_display_name', value: 'Requester User' },
        { key: 'identifier', value: 'AWS Test' },
        { key: 'is_uid', value: 'false' },
        { key: 'justification', value: 'Need temporary share link' },
        { key: 'duration', value: '5m' },
        { key: 'is_nsf', value: 'false' },
        { key: '__action', value: 'search_ots' },
      ],
    },
  });

  await app9.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_OTS_APPROVE' },
    action: {
 // OTS-suffixed method must force one-time share even if request_type is missing
      actionMethodName: 'approve_search_result_ots',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-OTS' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'requester_display_name', value: 'Requester User' },
        { key: 'identifier', value: 'AWS Test' },
        { key: 'is_uid', value: 'false' },
        { key: 'justification', value: 'Need temporary share link' },
        { key: 'duration', value: '5m' },
        { key: 'is_nsf', value: 'false' },
        { key: '__action', value: 'approve_search_result_ots' },
      ],
    },
    common: {
      formInputs: {
        selected_record: {
          stringInputs: {
            value: ['kR3cF9Xm2Lp8NqT1uV6w|classic|login'],
          },
        },
        permission: { stringInputs: { value: ['can_edit'] } },
        duration: { stringInputs: { value: ['5m'] } },
      },
    },
  });

  console.log('\nOne-time share flows completed successfully.');

  console.log('\n=== Record owner edge case ===');
  const mockChatOwner = new MockChatClient();
  const appOwner = new KeeperGoogleChatApp(config, {
    chatClient: mockChatOwner,
    keeperClient: new MockKeeperClient(),
  });

  console.log('\nStep 17: approve when requester already owns the record');
  await appOwner.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: { name: 'spaces/APPROVALS_DEMO/messages/MSG_OWNER' },
    action: {
      actionMethodName: 'approve_request',
      parameters: [
        { key: 'approval_id', value: 'APR-TEST-OWNER' },
        { key: 'requester_user_name', value: 'users/requester' },
        { key: 'requester_email', value: 'requester@example.com' },
        { key: 'requester_display_name', value: 'Requester User' },
        { key: 'identifier', value: 'ownedRecordUid012345678' },
        { key: 'is_uid', value: 'true' },
        { key: 'request_type', value: 'record' },
        { key: 'justification', value: 'Need access to my own record' },
        { key: 'duration', value: '1h' },
        { key: 'is_nsf', value: 'false' },
        { key: '__action', value: 'approve_request' },
      ],
    },
    common: {
      formInputs: {
        permission: { stringInputs: { value: ['view_only'] } },
        duration: { stringInputs: { value: ['1h'] } },
      },
    },
  });

  const ownerPatch = mockChatOwner.patches.find((p) =>
    String(p.message?.text || '').includes('User Already Has Full Access (Owner)'),
  );
  if (!ownerPatch) {
    throw new Error('Expected owner-conflict status on approval card');
  }
  const ownerDm = mockChatOwner.dms.find((d) =>
    String(d.text || '').includes('already has full permissions'),
  );
  if (!ownerDm) {
    throw new Error('Expected owner-conflict DM to approver');
  }
  console.log('\nRecord owner edge case completed successfully.');

  console.log('\n=== Create secret flow ===');
  const mockChatSecret = new MockChatClient();
  const mockKeeperSecret = new MockKeeperClient();
  const appSecret = new KeeperGoogleChatApp(config, {
    chatClient: mockChatSecret,
    keeperClient: mockKeeperSecret,
  });

  console.log('\nStep 18: requester submits /keeper-create-secret');
  await appSecret.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: {
      name: 'spaces/REQUESTER_DM',
      spaceType: 'DIRECT_MESSAGE',
      type: 'DM',
      singleUserBotDm: true,
    },
    message: {
      text: '/keeper-create-secret',
      slashCommand: { commandId: config.chat.commandCreateSecretId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD_SECRET' },
    },
  });

  const folderSelect = mockChatSecret.messages.find(
    (m) =>
      m.privateViewer === 'users/requester' &&
      m.preferInPlace === true &&
      m.message?.cardsV2?.[0]?.cardId === 'create-secret-folder',
  );
  if (!folderSelect) {
    throw new Error('Expected create-secret folder select card in-place (not bot DM)');
  }
  const folderSelectDmLeak = mockChatSecret.dms.find(
    (d) => d.cardsV2?.[0]?.cardId === 'create-secret-folder',
  );
  if (folderSelectDmLeak) {
    throw new Error('create-secret folder card should not route to bot DM');
  }

  console.log('\nStep 19: select shared folder → form');
  await appSecret.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      name: 'spaces/REQUESTER_DM/messages/MSG_CREATE_SECRET',
    },
    action: {
      actionMethodName: 'create_secret_next',
      parameters: [{ key: '__action', value: 'create_secret_next' }],
    },
    common: {
      formInputs: {
        shared_folder: {
          stringInputs: {
            value: ['sharedFolderClassicUid01|classic|'],
          },
        },
      },
    },
  });

  const formPatch = mockChatSecret.patches.find(
    (p) => p.message?.cardsV2?.[0]?.cardId === 'create-secret-form',
  );
  if (!formPatch) {
    throw new Error('Expected create-secret form card patch');
  }

  console.log('\nStep 20: submit create secret (classic + subfolder)');
  await appSecret.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      name: 'spaces/REQUESTER_DM/messages/MSG_CREATE_SECRET',
    },
    action: {
      actionMethodName: 'create_secret_submit',
      parameters: [
        { key: 'folder_uid', value: 'sharedFolderClassicUid01' },
        { key: 'folder_name', value: 'Engineering Creds' },
        { key: 'parent_is_nsf', value: 'false' },
        { key: '__action', value: 'create_secret_submit' },
      ],
    },
    common: {
      formInputs: {
        subfolder: {
          stringInputs: {
            value: ['subfolderClassicUid0123|classic|'],
          },
        },
        secret_title: { stringInputs: { value: ['Demo API Key'] } },
        secret_login: { stringInputs: { value: ['demo@example.com'] } },
        auto_gen_password: { stringInputs: { value: ['auto_gen'] } },
        secret_password: { stringInputs: { value: [''] } },
        secret_url: { stringInputs: { value: ['https://example.com'] } },
        secret_notes: { stringInputs: { value: ['created via local test'] } },
      },
    },
  });

  const successPatch = mockChatSecret.patches.find(
    (p) => p.message?.cardsV2?.[0]?.cardId === 'create-secret-success',
  );
  if (!successPatch) {
    throw new Error('Expected create-secret success card');
  }

  const notify = mockChatSecret.messages.find(
    (m) =>
      m.parent === 'spaces/APPROVALS_DEMO' &&
      m.message?.cardsV2?.[0]?.cardId === 'create-secret-notify',
  );
  if (!notify) {
    throw new Error('Expected create-secret notification in approvals space');
  }

  console.log('\nStep 21: NSF parent folder create');
  const mockChatNsf = new MockChatClient();
  const appNsf = new KeeperGoogleChatApp(config, {
    chatClient: mockChatNsf,
    keeperClient: new MockKeeperClient(),
  });
  await appNsf.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: { name: 'spaces/REQUESTER_DM/messages/MSG_CREATE_SECRET_NSF' },
    action: {
      actionMethodName: 'create_secret_submit',
      parameters: [
        { key: 'folder_uid', value: 'sharedFolderNsfUid012345' },
        { key: 'folder_name', value: 'NSF Team Vault' },
        { key: 'parent_is_nsf', value: 'true' },
        { key: '__action', value: 'create_secret_submit' },
      ],
    },
    common: {
      formInputs: {
        secret_title: { stringInputs: { value: ['NSF Secret'] } },
        auto_gen_password: { stringInputs: { value: ['auto_gen'] } },
      },
    },
  });
  const nsfSuccess = mockChatNsf.patches.find(
    (p) => p.message?.cardsV2?.[0]?.cardId === 'create-secret-success',
  );
  if (!nsfSuccess) {
    throw new Error('Expected NSF create-secret success card');
  }

  console.log('\nCreate secret flows completed successfully.');

  console.log('\n=== EPM / EPM elevation approval flow ===');
  const mockChatEpm = new MockChatClient();
  const mockKeeperEpm = new MockKeeperClient();
  const epmConfig = loadConfigSync('config.example.yaml');
  epmConfig.chat.approvalsSpaceId = 'spaces/APPROVALS_DEMO';
  epmConfig.epm = { enabled: true, pollingIntervalInSec: 120 };
  const appEpm = new KeeperGoogleChatApp(epmConfig, {
    chatClient: mockChatEpm,
    keeperClient: mockKeeperEpm,
  });

  console.log('\nStep 22: parse EPM payload + justification hyperlink sanitization');
  const parsed = EpmRequest.fromDict(mockKeeperEpm.pendingEpmRequests[0]);
  if (parsed.username !== 'alice.admin' || parsed.fileName !== 'msiexec.exe') {
    throw new Error('EpmRequest.fromDict failed to parse account/application_info');
  }
  if (!parsed.justification.includes('Need to install patch')) {
    throw new Error('Expected justification text extracted from JSON');
  }
  const sanitizedJust = sanitizeHyperlinks(parsed.justification);
  if (sanitizedJust.includes(':') || sanitizedJust.includes('/')) {
    throw new Error('Expected sanitizeHyperlinks to strip : and / from justification');
  }

  console.log('\nStep 23: poller posts new pending EPM request once');
  await appEpm.epmPoller._checkAndPostNewRequests();
  const epmPosts = mockChatEpm.messages.filter(
    (m) =>
      m.parent === epmConfig.chat.approvalsSpaceId &&
      m.message?.cardsV2?.[0]?.cardId === 'epm-epmApprovalUid01234567',
  );
  if (epmPosts.length !== 1) {
    throw new Error(`Expected 1 EPM approval post, got ${epmPosts.length}`);
  }
  const epmCardText = JSON.stringify(epmPosts[0].message.cardsV2);
  if (!epmCardText.includes('Privilege Elevation Approval Request')) {
    throw new Error('Expected Privilege Elevation Approval Request header');
  }
  if (!epmCardText.includes('alice.admin') || !epmCardText.includes('msiexec.exe')) {
    throw new Error('Expected EPM user/executable on card');
  }
  if (!epmCardText.includes('approve_epm_request') || !epmCardText.includes('deny_epm_request')) {
    throw new Error('Expected Approve/Deny EPM actions on card');
  }
  // created: 2026-08-10T06:00:00Z → Admin Console GMT style
  const expectedEpmCreated = formatAdminConsoleTimestamp(
    new Date('2026-08-10T06:00:00Z'),
  );
  if (!epmCardText.includes(expectedEpmCreated)) {
    throw new Error(
      `Expected EPM Created stamp "${expectedEpmCreated}", got: ${epmCardText.slice(0, 500)}`,
    );
  }
  if (!expectedEpmCreated.includes('@') || !expectedEpmCreated.endsWith('GMT')) {
    throw new Error(`EPM Created stamp missing Admin Console GMT shape: ${expectedEpmCreated}`);
  }

  await appEpm.epmPoller._checkAndPostNewRequests();
  const epmPostsAfter = mockChatEpm.messages.filter(
    (m) => m.message?.cardsV2?.[0]?.cardId === 'epm-epmApprovalUid01234567',
  );
  if (epmPostsAfter.length !== 1) {
    throw new Error('EPM poller re-posted an already-seen request');
  }

  console.log('\nStep 24: approve EPM request updates card status');
  const postedCards = epmPosts[0].message.cardsV2;
  await appEpm.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: {
      name: 'spaces/APPROVALS_DEMO/messages/MSG_EPM_1',
      cardsV2: postedCards,
    },
    action: {
      actionMethodName: 'approve_epm_request',
      parameters: [
        { key: 'approval_uid', value: 'epmApprovalUid01234567' },
        { key: 'username', value: 'alice.admin' },
        { key: 'approval_type', value: 'PrivilegeElevation' },
        { key: '__action', value: 'approve_epm_request' },
      ],
    },
  });
  const approvePatch = mockChatEpm.patches.find((p) =>
    String(p.message?.text || '').includes('approved'),
  );
  if (!approvePatch) {
    throw new Error('Expected EPM approved status patch');
  }
  const approveBody = JSON.stringify(approvePatch.message.cardsV2);
  if (!approveBody.includes('Approved by')) {
    throw new Error('Expected Approved by status on EPM card');
  }
  if (approveBody.includes('"buttonList"')) {
    throw new Error('Expected Approve/Deny buttons removed after EPM action');
  }

  console.log('\nStep 25: already-processed EPM deny shows clear status');
  mockKeeperEpm.epmActionMode = 'already_processed';
  const cmdLineRequest = EpmRequest.fromDict({
    approval_uid: 'epmCmdLineUid012345678',
    approval_type: 'CommandLine',
    status: 'Pending',
    agent_uid: 'agentUidMock0123456789ab',
    account_info: ['Username=bob.ops'],
    application_info: [
      'Description=Shell elevate',
      'FileName=sudo',
      'FilePath=/usr/bin',
      'CommandLine=apt update',
    ],
    justification: 'Emergency patch',
    expire_in: 15,
    created: '2026-08-10T06:30:00Z',
  });
  await appEpm.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: {
      name: 'spaces/APPROVALS_DEMO/messages/MSG_EPM_2',
      cardsV2: buildEpmApprovalCard(cmdLineRequest),
    },
    action: {
      actionMethodName: 'deny_epm_request',
      parameters: [
        { key: 'approval_uid', value: 'epmCmdLineUid012345678' },
        { key: 'username', value: 'bob.ops' },
        { key: 'approval_type', value: 'CommandLine' },
        { key: '__action', value: 'deny_epm_request' },
      ],
    },
  });
  const alreadyPatch = mockChatEpm.patches.find((p) =>
    String(p.message?.text || '').includes('already processed'),
  );
  if (!alreadyPatch) {
    throw new Error('Expected already-processed EPM status patch');
  }
  if (!JSON.stringify(alreadyPatch.message.cardsV2).includes('Already processed')) {
    throw new Error('Expected Already processed status text on card');
  }

  console.log('\nStep 26: API null keeps seen list (no clear on failure)');
  mockKeeperEpm.pendingEpmRequests = null;
  const seenBefore = appEpm.epmPoller.seenApprovalUids.size;
  await appEpm.epmPoller._checkAndPostNewRequests();
  if (appEpm.epmPoller.seenApprovalUids.size !== seenBefore) {
    throw new Error('EPM poller cleared seen list on API null (should keep intact)');
  }
  mockKeeperEpm.pendingEpmRequests = [];
  await appEpm.epmPoller._checkAndPostNewRequests();
  if (appEpm.epmPoller.seenApprovalUids.size !== 0) {
    throw new Error('Expected seen list cleared when pending list is empty');
  }

  console.log('\nEPM elevation approval flows completed successfully.');

  console.log('\n=== Cloud SSO device approval flow ===');
  const mockChatDevice = new MockChatClient();
  const mockKeeperDevice = new MockKeeperClient();
  const deviceConfig = loadConfigSync('config.example.yaml');
  deviceConfig.chat.approvalsSpaceId = 'spaces/APPROVALS_DEMO';
  deviceConfig.deviceApproval = { enabled: true, pollingIntervalInSec: 120 };
  const appDevice = new KeeperGoogleChatApp(deviceConfig, {
    chatClient: mockChatDevice,
    keeperClient: mockKeeperDevice,
  });

  console.log('\nStep 27: poller posts new pending device once');
  await appDevice.devicePoller._checkAndPostNewRequests();
  const devicePosts = mockChatDevice.messages.filter(
    (m) =>
      m.parent === deviceConfig.chat.approvalsSpaceId &&
      m.message?.cardsV2?.[0]?.cardId === 'device-deviceMockId0123456789ab',
  );
  if (devicePosts.length !== 1) {
    throw new Error(`Expected 1 device approval post, got ${devicePosts.length}`);
  }
  const deviceCardText = JSON.stringify(devicePosts[0].message.cardsV2);
  if (!deviceCardText.includes('Cloud SSO Device Approval Request')) {
    throw new Error('Expected Cloud SSO Device Approval Request header');
  }
  if (
    !deviceCardText.includes('alice@example.com') ||
    !deviceCardText.includes('Alice MacBook') ||
    !deviceCardText.includes('203.0.113.10')
  ) {
    throw new Error('Expected device email/name/IP on card');
  }
  // Commander UTC date → Admin Console GMT style
  const expectedDeviceRequested = formatDeviceRequestDate('2026-08-11 10:00:00');
  if (!deviceCardText.includes(expectedDeviceRequested)) {
    throw new Error(
      `Expected Requested "${expectedDeviceRequested}", got card: ${deviceCardText.slice(0, 500)}`,
    );
  }
  if (
    !expectedDeviceRequested.includes('@') ||
    !expectedDeviceRequested.endsWith('GMT')
  ) {
    throw new Error(
      `Device Requested stamp missing Admin Console GMT shape: ${expectedDeviceRequested}`,
    );
  }
  // UTC 10:00 stays 10:00 AM GMT
  if (!/10:00:00\s*AM/i.test(expectedDeviceRequested)) {
    throw new Error(
      `Expected GMT 10:00:00 AM for UTC input, got: ${expectedDeviceRequested}`,
    );
  }
  if (deviceCardText.includes('2026-08-11 100000')) {
    throw new Error('Requested timestamp lost colons (sanitizeHyperlinks bug)');
  }
  if (!deviceCardText.includes('approve_device') || !deviceCardText.includes('deny_device')) {
    throw new Error('Expected Approve Device / Deny Device actions on card');
  }

  await appDevice.devicePoller._checkAndPostNewRequests();
  const devicePostsAfter = mockChatDevice.messages.filter(
    (m) => m.message?.cardsV2?.[0]?.cardId === 'device-deviceMockId0123456789ab',
  );
  if (devicePostsAfter.length !== 1) {
    throw new Error('Device poller re-posted an already-seen request');
  }

  console.log('\nStep 28: approve device updates card status');
  await appDevice.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: {
      name: 'spaces/APPROVALS_DEMO/messages/MSG_DEVICE_1',
      cardsV2: devicePosts[0].message.cardsV2,
    },
    action: {
      actionMethodName: 'approve_device',
      parameters: [
        { key: 'device_id', value: 'deviceMockId0123456789ab' },
        { key: 'device_name', value: 'Alice MacBook' },
        { key: 'email', value: 'alice@example.com' },
        { key: '__action', value: 'approve_device' },
      ],
    },
  });
  const deviceApprovePatch = mockChatDevice.patches.find((p) =>
    String(p.message?.text || '').includes('approved'),
  );
  if (!deviceApprovePatch) {
    throw new Error('Expected device approved status patch');
  }
  const deviceApproveBody = JSON.stringify(deviceApprovePatch.message.cardsV2);
  if (!deviceApproveBody.includes('Approved by')) {
    throw new Error('Expected Approved by status on device card');
  }
  if (deviceApproveBody.includes('"buttonList"')) {
    throw new Error('Expected Approve/Deny buttons removed after device action');
  }

  console.log('\nStep 29: already-handled device deny shows clear status');
  mockKeeperDevice.deviceActionMode = 'already_handled';
  const secondDevice = {
    device_id: 'deviceMockIdOther0123456',
    device_name: 'Bob Phone',
    device_type: 'MOBILE',
    client_version: '16.11.0',
    email: 'bob@example.com',
    ip_address: '198.51.100.20',
    date: '2026-08-11 11:00:00',
  };
  await appDevice.handleEvent({
    type: 'CARD_CLICKED',
    user: {
      name: 'users/approver',
      email: 'approver@example.com',
      displayName: 'Approver User',
    },
    message: {
      name: 'spaces/APPROVALS_DEMO/messages/MSG_DEVICE_2',
      cardsV2: buildDeviceApprovalCard(secondDevice),
    },
    action: {
      actionMethodName: 'deny_device',
      parameters: [
        { key: 'device_id', value: 'deviceMockIdOther0123456' },
        { key: 'device_name', value: 'Bob Phone' },
        { key: 'email', value: 'bob@example.com' },
        { key: '__action', value: 'deny_device' },
      ],
    },
  });
  const deviceAlreadyPatch = mockChatDevice.patches.find((p) =>
    String(p.message?.text || '').includes('already processed'),
  );
  if (!deviceAlreadyPatch) {
    throw new Error('Expected already-processed device status patch');
  }
  if (!JSON.stringify(deviceAlreadyPatch.message.cardsV2).includes('Already processed')) {
    throw new Error('Expected Already processed status text on device card');
  }

  console.log('\nStep 30: empty pending clears seen list');
  mockKeeperDevice.pendingDeviceApprovals = [];
  await appDevice.devicePoller._checkAndPostNewRequests();
  if (appDevice.devicePoller.seenDeviceIds.size !== 0) {
    throw new Error('Expected device seen list cleared when pending list is empty');
  }

  console.log('\nCloud SSO device approval flows completed successfully.');

  console.log('\n=== Private replies always go to bot 1:1 DM ===');
  const mockChatPeerDm = new MockChatClient();
  const appPeerDm = new KeeperGoogleChatApp(config, {
    chatClient: mockChatPeerDm,
    keeperClient: new MockKeeperClient(),
  });

  console.log('\nStep 31: slash command in peer DM routes confirmations to bot DM only');
  await appPeerDm.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: {
      name: 'spaces/PEER_DM_WITH_OTHER_USER',
      spaceType: 'DIRECT_MESSAGE',
      type: 'DM',
    },
    message: {
      text: '/keeper-request-folder test need access',
      argumentText: 'test need access',
      slashCommand: { commandId: config.chat.commandRequestFolderId },
      thread: { name: 'spaces/PEER_DM_WITH_OTHER_USER/threads/T1' },
    },
  });

  const leakedToPeerDm = mockChatPeerDm.messages.filter(
    (m) =>
      m.parent === 'spaces/PEER_DM_WITH_OTHER_USER' &&
      String(m.message?.text || '').includes('request submitted'),
  );
  if (leakedToPeerDm.length) {
    throw new Error('Requester confirmation leaked into peer DM (should be bot DM only)');
  }

  const botDmConfirm = mockChatPeerDm.dms.find(
    (d) =>
      d.userName === 'users/requester' &&
      String(d.text || '').includes('Folder access request submitted'),
  );
  if (!botDmConfirm) {
    throw new Error('Expected folder confirmation DM to requester (bot 1:1)');
  }

  const approvalsStillPosted = mockChatPeerDm.messages.find(
    (m) => m.parent === config.chat.approvalsSpaceId,
  );
  if (!approvalsStillPosted) {
    throw new Error('Expected approval card still posted to approvals space');
  }

  console.log('\nStep 32: slash command in a space/channel also routes to bot DM only');
  const mockChatSpace = new MockChatClient();
  const appSpace = new KeeperGoogleChatApp(config, {
    chatClient: mockChatSpace,
    keeperClient: new MockKeeperClient(),
  });
  await appSpace.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: {
      name: 'spaces/TEAM_CHANNEL',
      spaceType: 'SPACE',
      type: 'ROOM',
    },
    message: {
      text: '/keeper-external-share test need ots',
      argumentText: 'test need ots',
      slashCommand: { commandId: config.chat.commandOneTimeShareId },
      thread: { name: 'spaces/TEAM_CHANNEL/threads/T2' },
    },
  });

  const leakedToChannel = mockChatSpace.messages.filter(
    (m) =>
      m.parent === 'spaces/TEAM_CHANNEL' &&
      String(m.message?.text || '').toLowerCase().includes('submitted'),
  );
  if (leakedToChannel.length) {
    throw new Error('Requester confirmation leaked into space/channel');
  }

  const channelBotDm = mockChatSpace.dms.find(
    (d) =>
      d.userName === 'users/requester' &&
      String(d.text || '').includes('External Share request submitted'),
  );
  if (!channelBotDm) {
    throw new Error('Expected OTS confirmation DM to requester from space command');
  }

  const channelApprovals = mockChatSpace.messages.find(
    (m) => m.parent === config.chat.approvalsSpaceId,
  );
  if (!channelApprovals) {
    throw new Error('Expected OTS approval card still posted to approvals space');
  }

  console.log('\nStep 33: create-secret in a space stays in-place (not bot DM)');
  const mockChatCreateSpace = new MockChatClient();
  const appCreateSpace = new KeeperGoogleChatApp(config, {
    chatClient: mockChatCreateSpace,
    keeperClient: new MockKeeperClient(),
  });
  await appCreateSpace.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: {
      name: 'spaces/TEAM_CHANNEL_CREATE',
      spaceType: 'SPACE',
      type: 'ROOM',
    },
    message: {
      text: '/keeper-create-secret',
      slashCommand: { commandId: config.chat.commandCreateSecretId },
      thread: { name: 'spaces/TEAM_CHANNEL_CREATE/threads/T3' },
    },
  });

  const createInPlace = mockChatCreateSpace.messages.find(
    (m) =>
      m.parent === 'spaces/TEAM_CHANNEL_CREATE' &&
      m.preferInPlace === true &&
      m.message?.cardsV2?.[0]?.cardId === 'create-secret-folder',
  );
  if (!createInPlace) {
    throw new Error('Expected create-secret folder card posted in the space');
  }
  if (
    mockChatCreateSpace.dms.some(
      (d) => d.cardsV2?.[0]?.cardId === 'create-secret-folder',
    )
  ) {
    throw new Error('create-secret must not send folder card to bot DM');
  }

  console.log('\nStep 34: create-secret in peer DM is rejected (no form leak)');
  const mockChatPeerCreate = new MockChatClient();
  const appPeerCreate = new KeeperGoogleChatApp(config, {
    chatClient: mockChatPeerCreate,
    keeperClient: new MockKeeperClient(),
  });
  await appPeerCreate.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: {
      name: 'spaces/PEER_DM_CREATE',
      spaceType: 'DIRECT_MESSAGE',
      type: 'DM',
    },
    message: {
      text: '/keeper-create-secret',
      slashCommand: { commandId: config.chat.commandCreateSecretId },
      thread: { name: 'spaces/PEER_DM_CREATE/threads/T4' },
    },
  });

  const leakedFolderInPeerDm = mockChatPeerCreate.messages.filter(
    (m) =>
      m.parent === 'spaces/PEER_DM_CREATE' &&
      m.message?.cardsV2?.[0]?.cardId === 'create-secret-folder',
  );
  if (leakedFolderInPeerDm.length) {
    throw new Error('create-secret folder card must not post into peer DM');
  }

  const peerRejectDm = mockChatPeerCreate.dms.find(
    (d) =>
      d.userName === 'users/requester' &&
      String(d.text || '').includes('cannot be used in a DM with another person'),
  );
  if (!peerRejectDm) {
    throw new Error('Expected create-secret peer-DM rejection in bot 1:1 DM');
  }

  console.log('\nBot-DM private routing (DM + space) + create-secret in-place completed successfully.');

  console.log('\nAll local flows completed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
