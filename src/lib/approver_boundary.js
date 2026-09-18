/**
 * Team-based boundary / scope enforcement for approver search.
 */

import { getLogger } from './logger.js';

/**
 * Return the raw multichannel_approver config block (never null/undefined).
 * @param {object} config
 */
function boundaryData(config) {
  return config?.multichannel_approver || {};
}

/**
 * Master gate: scope filtering only runs when multi-channel approver is
 * enabled. The per-team / per-kind UID lists then decide what is actually
 * restricted (see resolveAllowedScope).
 * @param {object} config
 * @returns {boolean}
 */
export function isBoundaryEnabled(config) {
  return Boolean(boundaryData(config).enabled);
}

/**
 * @param {object} config
 * @returns {object[]}
 */
function teamsConfig(config) {
  const teams = boundaryData(config).teams || [];
  return Array.isArray(teams) ? teams.filter((t) => t && typeof t === 'object') : [];
}

/**
 * True when at least one team declares any allowed folder/record UID.
 * Distinguishes "routing-only" mode (no team has scope) from "scoping active".
 * @param {object[]} teamsCfg
 * @returns {boolean}
 */
function anyScopeConfigured(teamsCfg) {
  return teamsCfg.some(
    (t) => (t.allowed_folder_uids || []).length || (t.allowed_record_uids || []).length,
  );
}

/**
 * Build per-kind scope sets from one team's UID lists.
 * Empty list for a kind -> null (unrestricted for that kind). Non-empty -> Set of UIDs.
 * @param {object} team
 * @returns {[Set<string>|null, Set<string>|null]} [folderScope, recordScope]
 */
function scopeFromTeamEntry(team) {
  const folderScope = new Set((team.allowed_folder_uids || []).filter(Boolean).map((u) => String(u).trim()));
  const recordScope = new Set((team.allowed_record_uids || []).filter(Boolean).map((u) => String(u).trim()));
  return [folderScope.size ? folderScope : null, recordScope.size ? recordScope : null];
}

/**
 * Return the approval-team config row whose space_id matches.
 * @param {object[]} teamsCfg
 * @param {string} channelId
 * @returns {object|null}
 */
function teamForChannel(teamsCfg, channelId) {
  const target = String(channelId || '').trim();
  if (!target) return null;
  return teamsCfg.find((t) => String(t.space_id || '').trim() === target) || null;
}

/**
 * Filter results by UID against an allowed set.
 * allowedUids === null means no restriction (pass through unchanged).
 * @param {object[]} results
 * @param {Set<string>|null} allowedUids
 */
function filterByUid(results, allowedUids) {
  if (allowedUids === null) return results;
  const filtered = results.filter((r) => allowedUids.has(r?.uid));
  return filtered;
}

export class ApproverBoundary {
  /**
   * @param {object} config - Application config with multichannel_approver section
   * @param {import('./keeper/client.js').KeeperClient} keeperClient
   */
  constructor(config, keeperClient) {
    this.config = config;
    this.keeperClient = keeperClient;
    this.logger = getLogger();
  }

  /** @returns {boolean} */
  isBoundaryEnabled() {
    return isBoundaryEnabled(this.config);
  }

  /**
   * Resolve which Google Chat space an approval request should be posted to.
   * Mirrors resolve_approval_channel(): route by the requester's Keeper team
   * membership (matched by team name) when multi-channel approver is enabled,
   * otherwise use the default approvals space.
   * @param {string} requesterEmail
   * @returns {Promise<string>}
   */
  async resolveApprovalChannel(requesterEmail) {
    const defaultChannel = this.config.chat?.approvalsSpaceId || '';

    // Mirrors Config.multichannel_approver: the enabled flag plus a
    // name -> space_id map built only from entries that have both fields.
    const nameToChannel = new Map();
    for (const team of teamsConfig(this.config)) {
      const name = String(team.name || '').trim();
      const channelId = String(team.space_id || '').trim();
      if (name && channelId) nameToChannel.set(name, channelId);
    }

    if (!this.isBoundaryEnabled() || !nameToChannel.size) {
      return defaultChannel;
    }

    try {
      const userTeams = await this.keeperClient.getUserTeams(requesterEmail);
      for (const teamName of userTeams) {
        const channel = nameToChannel.get(teamName);
        if (channel) {
          this.logger.info(
            { email: requesterEmail, teamName, channel },
            'Multi-channel routing: resolved approval channel via team membership',
          );
          return channel;
        }
      }

      this.logger.info(
        { email: requesterEmail, defaultChannel },
        'Multi-channel routing: no mapped team for requester; using default channel',
      );
      return defaultChannel;
    } catch (error) {
      this.logger.error(
        { err: error, email: requesterEmail },
        'Error resolving approval channel; using default channel',
      );
      return defaultChannel;
    }
  }

  /**
   * Resolve folder/record UID scope for an approver search.
   * @param {string} userEmail
   * @param {string} [channelId]
   * @returns {Promise<{ folderUids: Set<string>|null, recordUids: Set<string>|null }>}
   */
  async resolveAllowedScope(userEmail, channelId) {
    if (!this.isBoundaryEnabled()) {
      return { folderUids: null, recordUids: null };
    }

    const teamsCfg = teamsConfig(this.config);

    if (!anyScopeConfigured(teamsCfg)) {
      this.logger.debug(
        'Boundary: no UIDs configured on any team; routing-only mode -> no restriction',
      );
      return { folderUids: null, recordUids: null };
    }

    const trimmedChannelId = String(channelId || '').trim();
    if (trimmedChannelId) {
      const defaultChannel = String(this.config.chat?.approvalsSpaceId || '').trim();
      if (defaultChannel && trimmedChannelId === defaultChannel) {
        this.logger.info(
          { channelId: trimmedChannelId },
          'Boundary: default approval channel; no scope (traditional search)',
        );
        return { folderUids: null, recordUids: null };
      }

      const team = teamForChannel(teamsCfg, trimmedChannelId);
      if (team) {
        const [folderUids, recordUids] = scopeFromTeamEntry(team);
        this.logger.info(
          {
            channelId: trimmedChannelId,
            team: team.name || '<unnamed>',
            folders: folderUids === null ? 'ALL' : folderUids.size,
            records: recordUids === null ? 'ALL' : recordUids.size,
          },
          'Boundary: resolved scope via channel -> team mapping',
        );
        return { folderUids, recordUids };
      }
    }

    // Fallback: scope by the searching approver's Keeper team membership.
    try {
      const userTeams = new Set(await this.keeperClient.getUserTeams(userEmail));
      const folderScope = new Set();
      const recordScope = new Set();
      let matchedAny = false;

      for (const team of teamsCfg) {
        const name = String(team.name || '').trim();
        if (!userTeams.has(name)) continue;
        matchedAny = true;
        for (const uid of team.allowed_folder_uids || []) {
          if (uid) folderScope.add(String(uid).trim());
        }
        for (const uid of team.allowed_record_uids || []) {
          if (uid) recordScope.add(String(uid).trim());
        }
      }

      if (!matchedAny) {
        this.logger.info(
          { email: userEmail, userTeams: [...userTeams] },
          'Boundary: user in no approval team; deny (empty scope)',
        );
        return { folderUids: new Set(), recordUids: new Set() };
      }

      const folderResult = folderScope.size ? folderScope : null;
      const recordResult = recordScope.size ? recordScope : null;

      this.logger.info(
        {
          email: userEmail,
          userTeams: [...userTeams],
          folders: folderResult === null ? 'ALL' : folderResult.size,
          records: recordResult === null ? 'ALL' : recordResult.size,
        },
        'Boundary: resolved scope via team membership',
      );
      return { folderUids: folderResult, recordUids: recordResult };
    } catch (error) {
      this.logger.error(
        { err: error, email: userEmail },
        'Boundary: error resolving scope; deny (empty scope)',
      );
      return { folderUids: new Set(), recordUids: new Set() };
    }
  }

  /**
   * Filter record search results to an allowed record UID set.
   * @param {object[]} results
   * @param {Set<string>|null} allowedRecordUids
   */
  filterRecords(results, allowedRecordUids) {
    return filterByUid(results, allowedRecordUids);
  }

  /**
   * Filter folder search results to an allowed folder UID set.
   * @param {object[]} results
   * @param {Set<string>|null} allowedFolderUids
   */
  filterFolders(results, allowedFolderUids) {
    return filterByUid(results, allowedFolderUids);
  }
}
