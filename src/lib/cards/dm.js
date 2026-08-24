/**
 * Requester DM notification cards.
 */

import { BTN, escapeHtmlAttr, escapeHtmlText } from './shared.js';

import { formatPermissionName } from '../utils.js';

/**
 * Keeper vault deep link for records/folders 
 * @param {'record'|'folder'} itemType
 * @param {string} uid
 * @param {string} [serverDomain]
 */
export function getVaultDeepLink(itemType, uid, serverDomain = 'keepersecurity.com') {
  const domain = String(serverDomain || 'keepersecurity.com')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const safeUid = String(uid || '').trim();
  if (itemType === 'folder') {
    return `https://${domain}/vault/#shared_folder/${safeUid}`;
  }
  return `https://${domain}/vault/#detail/${safeUid}`;
}

/**
 * Requester DM after access is granted 
 * Includes vault deep link: Record/Folder Link → Open in Vault.
 */
export function buildAccessGrantedDm(approvalId, recordUid, permission, expiresAt, extras = {}) {
  const forFolder = Boolean(extras.forFolder);
  const itemLabel = forFolder ? 'Folder' : 'Record';
  const itemTitle = extras.itemTitle || recordUid;
  const deepLink = getVaultDeepLink(
    forFolder ? 'folder' : 'record',
    recordUid,
    extras.serverDomain,
  );
  const linkHtml = `<a href="${escapeHtmlAttr(deepLink)}">Open in Vault</a>`;
  const rotateNote = extras.rotateOnExpire
    ? '<br><b>Credentials will rotate when access expires.</b>'
    : '';
  const inviteNote = extras.invitationSent
    ? `<br><br>A Keeper invitation was sent. Accept it before accessing the ${forFolder ? 'folder' : 'record'}.`
    : '';
  const selfDestructNote = extras.selfDestruct
    ? `<br><br><b>Self-Destruct Record</b><br>This record will automatically delete from the vault after ${extras.selfDestructDuration || 'the configured duration'}.`
    : '';

  /** @type {object[]} */
  const widgets = [
    {
      textParagraph: {
        text:
          `<b>Request ID:</b> <code>${approvalId}</code><br>` +
          `<b>${itemLabel}:</b> ${escapeHtmlText(itemTitle)}<br>` +
          `<b>${itemLabel} Link:</b> ${linkHtml}<br>` +
          `<b>Permission:</b> ${formatPermissionName(permission)}<br>` +
          `<b>Expires:</b> ${expiresAt}` +
          rotateNote +
          inviteNote +
          selfDestructNote,
      },
    },
    {
      buttonList: {
        buttons: [
          {
            text: 'Open in Vault',
            color: BTN.search,
            onClick: {
              openLink: { url: deepLink },
            },
          },
        ],
      },
    },
  ];

  return [
    {
      cardId: `grant-${approvalId}`,
      card: {
        header: { title: 'Access Granted!' },
        sections: [{ widgets }],
      },
    },
  ];
}

/**
 * DM card with the one-time share URL after approval 
 * URL is an HTML hyperlink plus an Open Link button (opens in a new tab).
 */
export function buildOneTimeShareDm(approvalId, recordUid, permission, expiresAt, shareUrl) {
  const url = String(shareUrl || '').trim();
  const linkHtml = url
    ? `<a href="${escapeHtmlAttr(url)}">${escapeHtmlText(url)}</a>`
    : '(URL unavailable)';

  /** @type {object[]} */
  const widgets = [
    {
      textParagraph: {
        text:
          `<b>Request ID:</b> <code>${approvalId}</code><br>` +
          `<b>Record:</b> <code>${recordUid}</code><br>` +
          `<b>Permission:</b> ${formatPermissionName(permission)}<br>` +
          `<b>Expires:</b> ${expiresAt}<br><br>` +
          `<b>Share link:</b><br>${linkHtml}<br><br>` +
          '<i>This link can be opened without a Keeper account. ' +
          'It expires after the selected duration (or after first use, depending on Keeper settings).</i>',
      },
    },
  ];

  if (url) {
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: 'Open Share Link',
            color: BTN.search,
            onClick: {
              openLink: { url },
            },
          },
        ],
      },
    });
  }

  return [
    {
      cardId: `ots-${approvalId}`,
      card: {
        header: { title: 'External Share Link Ready' },
        sections: [{ widgets }],
      },
    },
  ];
}

/**
 * Requester DM after denial 
 */
export function buildAccessDeniedDm(approvalId, recordUid, extras = {}) {
  const forFolder = Boolean(extras.forFolder);
  const forOts = Boolean(extras.forOneTimeShare);
  const itemLabel = forFolder ? 'Folder' : 'Record';
  const itemWord = forOts ? 'One-time share' : forFolder ? 'Folder' : 'Record';
  const deniedBy = extras.approverName || extras.approverEmail || 'an approver';

  return [
    {
      cardId: `deny-${approvalId}`,
      card: {
        header: { title: 'Access Request Denied' },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text:
                    `<b>Request ID:</b> <code>${approvalId}</code><br>` +
                    `${itemWord} access request was denied by ${escapeHtmlText(deniedBy)}.<br><br>` +
                    `<b>${itemLabel}:</b> <code>${recordUid}</code><br><br>` +
                    'If you believe this was in error, please contact your manager or the security team.',
                },
              },
            ],
          },
        ],
      },
    },
  ];
}
