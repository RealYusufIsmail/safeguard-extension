'use strict';

// Steven Black's unified porn hosts file — plain-text, no auth required.
// Format: "0.0.0.0 domain.com" lines (with # comment lines).
const BLOCKLIST_URL =
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts';

const STORAGE_KEY     = 'remoteBlocklist';
const LAST_SYNC_KEY   = 'blocklistLastSync';
const DOMAIN_COUNT_KEY = 'blocklistDomainCount';
const MAX_DOMAINS     = 12000;
const ALARM_NAME      = 'safeguard-blocklist-sync';
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
  return set.has(clean);
}

// Fetches and parses the hosts file, storing the result in local storage.
async function syncBlocklist() {
  try {
    const resp = await fetch(BLOCKLIST_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();

    const domains = [];
    for (const line of text.split('\n')) {
      if (domains.length >= MAX_DOMAINS) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith('0.0.0.0 ')) continue;
      const domain = trimmed.slice(8).trim().toLowerCase();
      // Skip the loopback placeholder and obviously invalid entries
      if (!domain || domain === '0.0.0.0' || domain.includes(' ') || !domain.includes('.')) continue;
      domains.push(domain.replace(/^www\./, ''));
    }

    _blocklistSet = new Set(domains);

    await chrome.storage.local.set({
      [STORAGE_KEY]: domains,
      [LAST_SYNC_KEY]: Date.now(),
      [DOMAIN_COUNT_KEY]: domains.length,
    });

    return { ok: true, count: domains.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Returns last sync metadata for the popup.
async function getBlocklistMeta() {
  const result = await chrome.storage.local.get({
    [LAST_SYNC_KEY]: null,
    [DOMAIN_COUNT_KEY]: 0,
  });
  return {
    lastSync: result[LAST_SYNC_KEY],
    domainCount: result[DOMAIN_COUNT_KEY],
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
