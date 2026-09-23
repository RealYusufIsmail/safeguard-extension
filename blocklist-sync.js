'use strict';

// ── Blocklist sources ─────────────────────────────────────────────────────────
// Multiple independent sources are fetched in parallel and merged.
// Different teams curate each list, so gaps in one are covered by another.

const SOURCES = [
  {
    name: 'StevenBlack',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
    // Format: "0.0.0.0 domain.com"  (with # comment lines)
    parse(text) {
      const domains = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.startsWith('0.0.0.0 ')) continue;
        const d = t.slice(8).trim().toLowerCase();
        if (d && d !== '0.0.0.0' && !d.includes(' ') && d.includes('.')) {
          domains.push(d.replace(/^www\./, ''));
        }
      }
      return domains;
    },
  },
  {
    name: 'OISD-NSFW',
    url: 'https://nsfw.oisd.nl/domainswild',
    // Format: "*.domain.com" or "domain.com"  (plain list, may have wildcards)
    parse(text) {
      const domains = [];
      for (const line of text.split('\n')) {
        const t = line.trim().toLowerCase()
          .replace(/^\*\./, '')   // strip wildcard prefix
          .replace(/^www\./, '');
        if (!t || t.startsWith('#') || t.startsWith('!') || !t.includes('.')) continue;
        if (t.includes(' ') || t.includes('/')) continue; // skip non-domain lines
        domains.push(t);
      }
      return domains;
    },
  },
  {
    name: 'Hagezi-NSFW',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt',
    // Format: one domain per line
    parse(text) {
      const domains = [];
      for (const line of text.split('\n')) {
        const d = line.trim().toLowerCase();
        if (!d || d.startsWith('#') || !d.includes('.') || d.includes(' ') || d.includes('/')) continue;
        domains.push(d.replace(/^www\./, ''));
      }
      return domains;
    },
  },
];

const STORAGE_KEY      = 'remoteBlocklist';
const LAST_SYNC_KEY    = 'blocklistLastSync';
const DOMAIN_COUNT_KEY = 'blocklistDomainCount';
const SOURCE_STATS_KEY = 'blocklistSourceStats';
const MAX_DOMAINS      = 30000;   // larger cap — merged list is worth more entries
const ALARM_NAME       = 'safeguard-blocklist-sync';
const SYNC_INTERVAL_MINUTES = 1440; // 24 h

// In-memory cache — rebuilt when the service worker starts.
let _blocklistSet = null;

async function _loadSetFromStorage() {
  if (_blocklistSet) return _blocklistSet;
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  _blocklistSet = new Set(result[STORAGE_KEY]);
  return _blocklistSet;
}

// Returns true if the given hostname (no www.) is in the remote blocklist.
async function isRemoteBlocked(hostname) {
  const set = await _loadSetFromStorage();
  const clean = hostname.replace(/^www\./, '');
  const labels = clean.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (set.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

// Fetches a single source with a timeout; returns [] on failure.
async function _fetchSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000); // 20 s timeout
  try {
    const resp = await fetch(source.url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const domains = source.parse(text);
    console.info(`[SafeGuard] ${source.name}: ${domains.length} domains`);
    return { name: source.name, domains, error: null };
  } catch (err) {
    console.warn(`[SafeGuard] ${source.name} failed:`, err.message);
    return { name: source.name, domains: [], error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Fetches all sources in parallel, merges, deduplicates, and stores.
async function syncBlocklist() {
  const results = await Promise.all(SOURCES.map(_fetchSource));
  const errors = results.filter(({ error }) => error).map(({ name, error }) => `${name}: ${error}`);

  // Keep the last complete list when a provider is temporarily unavailable.
  if (errors.length) {
    const previous = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
    if (previous[STORAGE_KEY].length) {
      return { ok: false, error: 'Some sources failed; the previous blocklist is still active.', warnings: errors };
    }
  }

  // Sample each source across its full list before filling remaining capacity.
  const merged = new Set();
  const sourceStats = {};
  for (const { name, domains } of results) {
    sourceStats[name] = domains.length;
  }

  const available = results.filter(({ domains }) => domains.length);
  const perSource = Math.ceil(MAX_DOMAINS / available.length);
  for (const { domains } of available) {
    const picks = Math.min(perSource, domains.length);
    for (let i = 0; i < picks && merged.size < MAX_DOMAINS; i += 1) {
      merged.add(domains[Math.floor(i * domains.length / picks)]);
    }
  }
  for (const { domains } of available) {
    for (const domain of domains) {
      if (merged.size >= MAX_DOMAINS) break;
      merged.add(domain);
    }
    if (merged.size >= MAX_DOMAINS) break;
  }

  // Bail if every source failed
  const totalNew = merged.size;
  if (totalNew === 0) {
    return { ok: false, error: 'All sources returned 0 domains — check network.' };
  }

  const domainArray = Array.from(merged);
  _blocklistSet = merged;

  await chrome.storage.local.set({
    [STORAGE_KEY]:      domainArray,
    [LAST_SYNC_KEY]:    Date.now(),
    [DOMAIN_COUNT_KEY]: totalNew,
    [SOURCE_STATS_KEY]: sourceStats,
  });

  return {
    ok: true,
    count: totalNew,
    sourceStats,
    ...(errors.length ? { warnings: errors } : {}),
  };
}

// Returns last sync metadata for the popup.
async function getBlocklistMeta() {
  const result = await chrome.storage.local.get({
    [LAST_SYNC_KEY]:    null,
    [DOMAIN_COUNT_KEY]: 0,
    [SOURCE_STATS_KEY]: {},
  });
  return {
    lastSync:    result[LAST_SYNC_KEY],
    domainCount: result[DOMAIN_COUNT_KEY],
    sourceStats: result[SOURCE_STATS_KEY],
  };
}

// Registers (or refreshes) the periodic alarm.
function scheduleSync() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES });
    }
  });
}
