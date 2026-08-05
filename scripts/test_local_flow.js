/**
 * Offline end-to-end test without Google Cloud Pub/Sub.
 */

import { KeeperGoogleChatApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger, getLogger } from '../src/lib/logger.js';
import { KeeperFolder, KeeperRecord } from '../src/lib/models.js';

class MockChatClient {
  constructor() {
    this.messages = [];
    this.dms = [];
    this.patches = [];
  }

  async postMessage({ parent, message, threadName = null, privateViewer = null }) {
    const entry = { parent, message, thread: threadName, privateViewer };
    this.messages.push(entry);
    console.log('\n--- CHAT POST ---');
    console.log(`parent: ${parent}`);
    if (privateViewer) console.log(`private to: ${privateViewer}`);
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
    console.log(`text: ${text}`);
    if (cardsV2) console.log('cardsV2: notification card');
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

  /** Slack-parity stub: production uses Commander `server` command. */
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
}

async function main() {
  createLogger();
  const logger = getLogger();

  const config = loadConfig('config.example.yaml');
  config.chat.approvalsSpaceId = 'spaces/APPROVALS_DEMO';

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

  const before = mockChat.messages.length;
  await app.handleEvent(addonEvent);
  if (mockChat.messages.length <= before) {
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

  console.log('\nStep 15: requester submits /keeper-one-time-share by UID');
  await app8.handleEvent({
    type: 'MESSAGE',
    user: {
      name: 'users/requester',
      email: 'requester@example.com',
      displayName: 'Requester User',
    },
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-one-time-share kR3cF9Xm2Lp8NqT1uV6w Need temporary share link',
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
      text: '/keeper-one-time-share "AWS Test" Need temporary share link',
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
    space: { name: 'spaces/REQUESTER_DM' },
    message: {
      text: '/keeper-create-secret',
      slashCommand: { commandId: config.chat.commandCreateSecretId },
      thread: { name: 'spaces/REQUESTER_DM/threads/THREAD_SECRET' },
    },
  });

  const folderSelect = mockChatSecret.messages.find(
    (m) =>
      m.privateViewer === 'users/requester' &&
      m.message?.cardsV2?.[0]?.cardId === 'create-secret-folder',
  );
  if (!folderSelect) {
    throw new Error('Expected create-secret folder select card');
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

  console.log('\nAll local flows completed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
