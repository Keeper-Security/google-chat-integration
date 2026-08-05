/**
 * Helpers for parsing Google Chat interaction events.
 */

export function getSlashCommandId(message = {}) {
  let cmdId = message.slashCommand?.commandId;
  if (cmdId == null) {
    for (const annotation of message.annotations || []) {
      cmdId = annotation.slashCommand?.commandId;
      if (cmdId != null) break;
    }
  }
  if (cmdId == null) return null;
  const parsed = Number.parseInt(String(cmdId), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function getSlashCommandName(message = {}) {
  for (const annotation of message.annotations || []) {
    const name = annotation.slashCommand?.commandName;
    if (name) return String(name);
  }
  return '';
}

export function getArgumentText(message = {}) {
  const argumentText = (message.argumentText || '').trim();
  if (argumentText) return argumentText;

  const text = (message.text || '').trim();
  if (text.startsWith('/keeper-request-record')) {
    return text.slice('/keeper-request-record'.length).trim();
  }
  if (text.startsWith('/keeper-request-folder')) {
    return text.slice('/keeper-request-folder'.length).trim();
  }
  if (text.startsWith('/keeper-one-time-share')) {
    return text.slice('/keeper-one-time-share'.length).trim();
  }
  if (text.startsWith('/keeper-create-secret')) {
    return text.slice('/keeper-create-secret'.length).trim();
  }
  return text;
}

export function isRequestRecordCommand(message, configuredCommandId) {
  const cmdId = getSlashCommandId(message);
  if (cmdId != null && cmdId === configuredCommandId) return true;

  const commandName = getSlashCommandName(message);
  if (commandName === '/keeper-request-record' || commandName === 'keeper-request-record') {
    return true;
  }

  const text = (message.text || '').trim();
  return text.startsWith('/keeper-request-record');
}

export function isRequestFolderCommand(message, configuredCommandId) {
  const cmdId = getSlashCommandId(message);
  if (cmdId != null && cmdId === configuredCommandId) return true;

  const commandName = getSlashCommandName(message);
  if (commandName === '/keeper-request-folder' || commandName === 'keeper-request-folder') {
    return true;
  }

  const text = (message.text || '').trim();
  return text.startsWith('/keeper-request-folder');
}

export function isOneTimeShareCommand(message, configuredCommandId) {
  const cmdId = getSlashCommandId(message);
  if (cmdId != null && cmdId === configuredCommandId) return true;

  const commandName = getSlashCommandName(message);
  if (
    commandName === '/keeper-one-time-share' ||
    commandName === 'keeper-one-time-share'
  ) {
    return true;
  }

  const text = (message.text || '').trim();
  return text.startsWith('/keeper-one-time-share');
}

export function isCreateSecretCommand(message, configuredCommandId) {
  const cmdId = getSlashCommandId(message);
  if (cmdId != null && cmdId === configuredCommandId) return true;

  const commandName = getSlashCommandName(message);
  if (
    commandName === '/keeper-create-secret' ||
    commandName === 'keeper-create-secret'
  ) {
    return true;
  }

  const text = (message.text || '').trim();
  return text.startsWith('/keeper-create-secret');
}

/**
 * True when a CARD_CLICKED action belongs to /keeper-create-secret.
 */
export function isCreateSecretCardAction(event) {
  const action = event?.action || {};
  const params = action.parameters || [];
  const method =
    action.actionMethodName ||
    params.find((p) => p.key === '__action')?.value ||
    '';
  return String(method).startsWith('create_secret_');
}

export function isDmSpace(space = {}) {
  const spaceType = String(space.spaceType || space.type || '').toUpperCase();
  return spaceType === 'DM' || spaceType === 'DIRECT_MESSAGE';
}
