/**
 * Approver-side catalog view for team-scoped searches.
 */

import { getLogger } from './logger.js';

const MAX_CONCURRENCY = 8;

/**
 * Run `worker` over `items` with at most `limit` concurrent invocations in
 * flight at any time.
 * @param {any[]} items
 * @param {number} limit
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<any[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

/**
 * Should the caller render a catalog (as opposed to running a Commander
 * search) for this kind?
 * @param {Set<string>|null} scope
 * @returns {boolean}
 */
export function isCatalogMode(scope) {
  return scope instanceof Set && scope.size > 0;
}

/**
 * Fetch each UID via the given getter on keeperClient, capped at
 * MAX_CONCURRENCY in-flight requests at a time. Silently drops UIDs that
 * come back null/undefined (deleted / no access), with a single warn log
 * listing the missing UIDs.
 * @param {import('./keeper/client.js').KeeperClient} keeperClient
 * @param {Iterable<string>} uids
 * @param {string} getterName
 * @param {string} kindLabel
 */
async function hydrateKind(keeperClient, uids, getterName, kindLabel) {
  const logger = getLogger();
  const seen = new Set();
  const uidList = [];
  for (const raw of uids) {
    const u = String(raw || '').trim();
    if (u && !seen.has(u)) {
      seen.add(u);
      uidList.push(u);
    }
  }
  if (!uidList.length) return [];

  const fetch = keeperClient[getterName];
  if (typeof fetch !== 'function') {
    logger.error(
      { getterName, kindLabel },
      'Catalog: keeperClient is missing getter; cannot hydrate',
    );
    return [];
  }

  const results = [];
  const missing = [];

  await mapWithConcurrency(uidList, MAX_CONCURRENCY, async (uid) => {
    try {
      const item = await fetch.call(keeperClient, uid);
      if (item == null) missing.push(uid);
      else results.push(item);
    } catch (error) {
      logger.warn({ err: error, uid, kindLabel }, 'Catalog: failed to fetch item');
      missing.push(uid);
    }
  });

  if (missing.length) {
    logger.warn(
      { count: missing.length, missing, kindLabel },
      'Catalog: skipping unavailable UID(s) (deleted or no access)',
    );
  }

  const sortKey = (item) => String(item?.title || item?.name || '').toLowerCase();
  results.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return results;
}

/**
 * Hydrate the scoped record UIDs into KeeperRecord objects.
 * @param {import('./keeper/client.js').KeeperClient} keeperClient
 * @param {Iterable<string>} uids
 */
export async function hydrateRecords(keeperClient, uids) {
  return hydrateKind(keeperClient, uids, 'getRecordByUid', 'record');
}

/**
 * Hydrate the scoped folder UIDs into KeeperFolder objects.
 * @param {import('./keeper/client.js').KeeperClient} keeperClient
 * @param {Iterable<string>} uids
 */
export async function hydrateFolders(keeperClient, uids) {
  return hydrateKind(keeperClient, uids, 'getFolderByUid', 'folder');
}

/**
 * Client-side substring filter over an already-hydrated catalog.
 * Empty query -> full list (preserves catalog ordering).
 * @param {object[]} items
 * @param {string} query
 */
export function filterItems(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => {
    const title = item?.title;
    const name = item?.name;
    return (title && String(title).toLowerCase().includes(q)) ||
      (name && String(name).toLowerCase().includes(q));
  });
}

export class ApproverCatalog {
  /**
   * @param {import('./approver_boundary.js').ApproverBoundary} boundary
   * @param {import('./keeper/client.js').KeeperClient} keeperClient
   */
  constructor(boundary, keeperClient) {
    this.boundary = boundary;
    this.keeperClient = keeperClient;
    this.logger = getLogger();
  }

  /**
   * Single entry point used by every catalog-aware call site.
   * @param {string} userEmail
   * @param {'record'|'folder'} searchType
   * @param {string} query
   * @param {string} [channelId]
   * @returns {Promise<object[]|null>}
   */
  async maybeCatalogFetch(userEmail, searchType, query, channelId) {
    const { folderUids, recordUids } = await this.boundary.resolveAllowedScope(userEmail, channelId);
    const scope = searchType === 'record' ? recordUids : folderUids;

    if (!isCatalogMode(scope)) {
      return null;
    }

    const items =
      searchType === 'record'
        ? await hydrateRecords(this.keeperClient, scope)
        : await hydrateFolders(this.keeperClient, scope);

    this.logger.info(
      { searchType, scopeSize: scope.size, hydratedCount: items.length },
      'Catalog: scope hydrated',
    );

    return filterItems(items, query);
  }
}
