importScripts('classifier.js', 'blocklist-sync.js');

// ── In-memory caches (rebuilt when service worker wakes) ─────────────────────

let _customSitesCache   = null;   // string[] of domains from storage
let _keywordsCache      = null;   // string[] of blocked keywords
let _adultEnabledCache  = null;
let _classifierCache    = null;

async function getSetting(key, def) {
  const r = await chrome.storage.sync.get({ [key]: def });
  return r[key];
}

function invalidateCaches() {
  _customSitesCache  = null;
  _keywordsCache     = null;
  _adultEnabledCache = null;
  _classifierCache   = null;
}

async function getCustomSites() {
  if (_customSitesCache !== null) return _customSitesCache;
  _customSitesCache = await getSetting('customBlockedSites', []);
  return _customSitesCache;
}

async function getKeywords() {
  if (_keywordsCache !== null) return _keywordsCache;
  _keywordsCache = await getSetting('blockedKeywords', []);
  return _keywordsCache;
}

async function getAdultEnabled() {
  if (_adultEnabledCache !== null) return _adultEnabledCache;
  _adultEnabledCache = await getSetting('adultBlockEnabled', true);
  return _adultEnabledCache;
}

async function getClassifierEnabled() {
  if (_classifierCache !== null) return _classifierCache;
  _classifierCache = await getSetting('classifierEnabled', true);
  return _classifierCache;
}

// Keep settings caches fresh when changed from the popup or another window
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') invalidateCaches();
});

// ── Block statistics (stored in local storage) ───────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function recordBlock() {
  const data = await chrome.storage.local.get({
    statsTotal: 0,
    statsToday: 0,
    statsTodayDate: todayKey(),
  });
  const today = todayKey();
  const statsToday = data.statsTodayDate === today ? data.statsToday + 1 : 1;
  await chrome.storage.local.set({
    statsTotal: data.statsTotal + 1,
    statsToday,
    statsTodayDate: today,
  });
  // Badge shows today's block count at a glance
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#f43f5e' });
    await chrome.action.setBadgeText({ text: statsToday > 999 ? '999+' : String(statsToday) });
  } catch (_) {}
}

async function getStats() {
  const data = await chrome.storage.local.get({
    statsTotal: 0,
    statsToday: 0,
    statsTodayDate: todayKey(),
  });
  const today = data.statsTodayDate === todayKey() ? data.statsToday : 0;
  return { total: data.statsTotal, today };
}

// ── declarativeNetRequest — only used to toggle the static adult ruleset ─────

async function rebuildRules() {
  invalidateCaches();
  const adultEnabled = await getAdultEnabled();

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      adultEnabled
        ? { enableRulesetIds: ['adult_block_rules'], disableRulesetIds: [] }
        : { enableRulesetIds: [], disableRulesetIds: ['adult_block_rules'] }
    );
  } catch (e) {
    console.error('[SafeGuard] ruleset toggle:', e);
  }

  // Remove any leftover dynamic rules from the old approach
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  }
}

// ── Known adult domains ───────────────────────────────────────────────────────

const KNOWN_ADULT = new Set([
  'pornhub.com','xvideos.com','xnxx.com','xhamster.com','redtube.com',
  'youporn.com','tube8.com','brazzers.com','bangbros.com','naughtyamerica.com',
  'realitykings.com','mofos.com','digitalplayground.com','vivid.com','pornmd.com',
  'tnaflix.com','beeg.com','spankbang.com','hclips.com','motherless.com',
  'slutload.com','drtuber.com','empflix.com','fapdu.com','fuq.com',
  'sunporno.com','porntrex.com','hdporn.com','porndig.com','iceporn.com',
]);

function isKnownAdult(hostname) {
  for (const d of KNOWN_ADULT) {
    if (hostname === d || hostname.endsWith('.' + d)) return true;
  }
  return false;
}

// ── On-demand NSFW image scanner injection ────────────────────────────────────

const _scannedTabs = new Set();   // tabs we've already injected into this navigation

async function injectScanner(tabId) {
  if (_scannedTabs.has(tabId)) return;
  _scannedTabs.add(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // nsfwjs.min.js is a standalone bundle (TensorFlow.js included).
      files: ['vendor/nsfwjs.min.js', 'nsfw-scan.js'],
    });
  } catch (e) {
    _scannedTabs.delete(tabId);
    console.warn('[SafeGuard] scanner injection failed:', e.message);
  }
}

// ── webNavigation — single place all blocking decisions are made ──────────────

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  _scannedTabs.delete(details.tabId);   // fresh navigation → allow a new scan

  let url, hostname;
  try {
    url      = new URL(details.url);
    hostname = url.hostname.replace(/^www\./, '');
  } catch { return; }

  // Skip browser-internal pages and our own extension pages
  if (['chrome:', 'chrome-extension:', 'about:', 'data:'].includes(url.protocol)) return;

  let reason = null;

  // 1. Custom blocked sites — always enforced regardless of adult toggle
  const customSites = await getCustomSites();
  if (customSites.some((s) => hostname === s || hostname.endsWith('.' + s))) {
    reason = 'custom';
  }

  // 2. Keyword blocking — block if any keyword appears in the host or full URL
  if (!reason) {
    const keywords = await getKeywords();
    if (keywords.length) {
      const haystack = (hostname + url.pathname + url.search).toLowerCase();
      if (keywords.some((kw) => kw && haystack.includes(kw))) {
        reason = 'keyword';
      }
    }
  }

  if (!reason) {
    const adultEnabled = await getAdultEnabled();
    if (adultEnabled) {

      // 2. Known adult domain list
      if (isKnownAdult(hostname)) {
        reason = 'adult';
      }

      // 3. Community blocklist (Steven Black / UT1)
      if (!reason && await isRemoteBlocked(hostname)) {
        reason = 'blocklist';
      }

      // 4. TF-IDF URL classifier — catches unknown adult sites by pattern
      if (!reason && await getClassifierEnabled()) {
        const result = classifyURL(details.url);
        if (result.isAdult) {
          reason = 'classifier';
          console.info('[SafeGuard] classifier hit:', hostname,
            'score:', result.score.toFixed(1), 'tokens:', result.matchedTokens.join(', '));
        }
      }
    }
  }

  if (reason) {
    await recordBlock();
    const stats = await getStats();
    const blockedUrl = chrome.runtime.getURL('blocked.html') +
      '?site=' + encodeURIComponent(hostname) +
      '&reason=' + reason +
      '&today=' + stats.today;
    chrome.tabs.update(details.tabId, { url: blockedUrl });
  }
});

// ── Alarm — periodic blocklist refresh ───────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.info('[SafeGuard] scheduled blocklist sync…');
    const result = await syncBlocklist();
    console.info('[SafeGuard] sync done:', result);
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'REBUILD_RULES') {
    rebuildRules()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'SYNC_BLOCKLIST') {
    syncBlocklist()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_BLOCKLIST_META') {
    getBlocklistMeta()
      .then((m) => sendResponse(m))
      .catch(() => sendResponse({ lastSync: null, domainCount: 0 }));
    return true;
  }

  if (message.type === 'GET_STATS') {
    getStats()
      .then((s) => sendResponse(s))
      .catch(() => sendResponse({ total: 0, today: 0 }));
    return true;
  }

  // Content gate flagged this tab as borderline → lazy-inject the image scanner.
  if (message.type === 'NSFW_SCAN_REQUEST') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId != null) injectScanner(tabId);
    return false;
  }

  // Scanner confirmed adult imagery → record the block and show blocked page.
  if (message.type === 'NSFW_CONFIRMED') {
    const tabId = _sender.tab && _sender.tab.id;
    if (tabId != null) {
      recordBlock().then(async () => {
        const stats = await getStats();
        const host = message.host || 'this page';
        const blockedUrl = chrome.runtime.getURL('blocked.html') +
          '?site=' + encodeURIComponent(host) + '&reason=image&today=' + stats.today;
        chrome.tabs.update(tabId, { url: blockedUrl });
      });
    }
    return false;
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function init() {
  await rebuildRules();
  scheduleSync();

  const meta = await getBlocklistMeta();
  if (!meta.lastSync) {
    console.info('[SafeGuard] first run — syncing blocklist…');
    syncBlocklist().then((r) => console.info('[SafeGuard] initial sync:', r));
  }
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
