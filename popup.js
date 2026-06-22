'use strict';

const $ = (id) => document.getElementById(id);

const adultToggle      = $('adultToggle');
const classifierToggle = $('classifierToggle');
const imageScanToggle  = $('imageScanToggle');
const sensSlider       = $('sensSlider');
const sensVal          = $('sensVal');
const sensitivityWrap  = $('sensitivityWrap');
const siteInput        = $('siteInput');
const addBtn           = $('addBtn');
const siteList         = $('siteList');
const kwInput          = $('kwInput');
const kwAddBtn         = $('kwAddBtn');
const kwList           = $('kwList');
const statusBar        = $('statusBar');
const statusText       = $('statusText');
const domainCountEl    = $('domainCount');
const lastSyncEl       = $('lastSync');
const syncBtn          = $('syncBtn');
const syncBar          = $('syncBar');
const statTodayEl      = $('statToday');
const statTotalEl      = $('statTotal');
const focusBanner      = $('focusBanner');
const focusStart       = $('focusStart');
const focusCountdown   = $('focusCountdown');
const sitesLock        = $('sitesLock');
const kwLock           = $('kwLock');

let focusTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg, type = 'idle') {
  statusBar.className = 'status-bar' + (type !== 'idle' ? ' ' + type : '');
  statusText.textContent = msg;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function normalizeDomain(s) {
  return s.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'').replace(/^www\./,'');
}
function formatDate(ts) {
  if (!ts) return 'Never synced';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m/60)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' });
}
function formatCount(n) { return !n ? '—' : (n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n)); }
function sensitivityLabel(v) {
  if (v <= 20) return 'Lenient';
  if (v <= 40) return 'Relaxed';
  if (v <= 60) return 'Balanced';
  if (v <= 80) return 'Strict';
  return 'Very strict';
}
function updateSensitivityUI(active) {
  // Slider is usable only when image scan is on and Focus Mode isn't locking it.
  sensitivityWrap.classList.toggle('disabled', !imageScanToggle.checked || active);
  sensSlider.disabled = !imageScanToggle.checked || active;
  sensVal.textContent = sensitivityLabel(parseInt(sensSlider.value, 10));
}

// ── Settings access ───────────────────────────────────────────────────────────

function getSettings() {
  return chrome.storage.sync.get({
    customBlockedSites: [],
    blockedKeywords:    [],
    adultBlockEnabled:  true,
    classifierEnabled:  true,
    imageScanEnabled:   true,
    imageScanSensitivity: 50,
    focusUntil:         0,
  });
}
async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  await chrome.runtime.sendMessage({ type: 'REBUILD_RULES' });
}
function focusActive(s) { return s.focusUntil && Date.now() < s.focusUntil; }

// ── Stats ─────────────────────────────────────────────────────────────────────

async function refreshStats() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  statTodayEl.textContent = s.today ?? 0;
  statTotalEl.textContent = (s.total ?? 0).toLocaleString();
}

// ── Focus Mode ─────────────────────────────────────────────────────────────────

function renderFocus(s) {
  const active = focusActive(s);
  focusBanner.classList.toggle('show', active);
  focusStart.style.display = active ? 'none' : 'block';
  sitesLock.classList.toggle('show', active);
  kwLock.classList.toggle('show', active);

  // Lock the off-switches and removal controls while focusing
  adultToggle.disabled = active;
  classifierToggle.disabled = active;
  imageScanToggle.disabled = active;
  siteInput.disabled = active;
  addBtn.disabled = active;
  kwInput.disabled = active;
  kwAddBtn.disabled = active;
  document.querySelectorAll('.list-item-remove').forEach((b) => (b.disabled = active));
  updateSensitivityUI(active);

  if (focusTimer) { clearInterval(focusTimer); focusTimer = null; }
  if (active) {
    const tick = () => {
      const left = Math.max(0, s.focusUntil - Date.now());
      if (left <= 0) { clearInterval(focusTimer); focusTimer = null; reload(); return; }
      const totalSec = Math.floor(left / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const sec = totalSec % 60;
      focusCountdown.textContent = h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
        : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    };
    tick();
    focusTimer = setInterval(tick, 1000);
  }
}

document.querySelectorAll('.focus-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mins = parseInt(btn.dataset.min, 10);
    const s = await getSettings();
    const until = Date.now() + mins * 60000;
    // Force-enable adult protection when a focus session starts
    await chrome.storage.sync.set({ focusUntil: until, adultBlockEnabled: true });
    await chrome.runtime.sendMessage({ type: 'REBUILD_RULES' });
    setStatus(`Focus mode on for ${mins} min — stay strong 💪`, 'success');
    reload();
  });
});

// ── Sync ───────────────────────────────────────────────────────────────────────

async function refreshBlocklistMeta() {
  const meta = await chrome.runtime.sendMessage({ type: 'GET_BLOCKLIST_META' });
  domainCountEl.innerHTML = formatCount(meta.domainCount) + '<span>domains</span>';
  lastSyncEl.textContent  = formatDate(meta.lastSync);
}
function setSyncing(active) {
  syncBtn.disabled = active;
  syncBtn.classList.toggle('syncing', active);
  syncBar.classList.toggle('indeterminate', active);
  if (!active) syncBar.style.width = '0%';
}
syncBtn.addEventListener('click', async () => {
  setSyncing(true);
  setStatus('Syncing community blocklist…');
  const r = await chrome.runtime.sendMessage({ type: 'SYNC_BLOCKLIST' });
  setSyncing(false);
  if (r.ok) {
    syncBar.style.width = '100%';
    setTimeout(() => { syncBar.style.width = '0%'; }, 1200);
    await refreshBlocklistMeta();
    setStatus(`Blocklist updated — ${r.count.toLocaleString()} domains`, 'success');
  } else {
    setStatus('Sync failed: ' + (r.error || 'unknown'), 'error');
  }
});

// ── List rendering ───────────────────────────────────────────────────────────

function renderList(el, items, emptyMsg) {
  el.innerHTML = '';
  if (!items.length) { el.innerHTML = `<div class="empty-state">${emptyMsg}</div>`; return; }
  items.forEach((val, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `<span class="list-item-name">${escapeHtml(val)}</span>
      <button class="list-item-remove" data-index="${i}" title="Remove">✕</button>`;
    el.appendChild(row);
  });
}

// ── Main render ─────────────────────────────────────────────────────────────────

async function reload() {
  const s = await getSettings();
  adultToggle.checked = s.adultBlockEnabled;
  classifierToggle.checked = s.classifierEnabled;
  imageScanToggle.checked = s.imageScanEnabled;
  sensSlider.value = s.imageScanSensitivity;
  renderList(siteList, s.customBlockedSites, 'No custom sites blocked yet.');
  renderList(kwList, s.blockedKeywords, 'No keywords blocked yet.');
  renderFocus(s);                    // applies locks after lists render
  await refreshStats();
  await refreshBlocklistMeta();
  if (!focusActive(s)) {
    const c = s.customBlockedSites.length;
    setStatus(`Active — ${c} site${c !== 1 ? 's' : ''}, ${s.blockedKeywords.length} keyword${s.blockedKeywords.length !== 1 ? 's' : ''}`, 'success');
  }
}

// ── Toggle handlers ─────────────────────────────────────────────────────────────

adultToggle.addEventListener('change', async () => {
  await saveSettings({ adultBlockEnabled: adultToggle.checked });
  setStatus(adultToggle.checked ? 'Adult blocking on' : 'Adult blocking off', 'success');
});
classifierToggle.addEventListener('change', async () => {
  await saveSettings({ classifierEnabled: classifierToggle.checked });
  setStatus(classifierToggle.checked ? 'Classifier on' : 'Classifier off', 'success');
});
imageScanToggle.addEventListener('change', async () => {
  await saveSettings({ imageScanEnabled: imageScanToggle.checked });
  updateSensitivityUI(false);
  setStatus(imageScanToggle.checked ? 'Image scan on' : 'Image scan off', 'success');
});

// Live label while dragging; persist when released.
sensSlider.addEventListener('input', () => {
  sensVal.textContent = sensitivityLabel(parseInt(sensSlider.value, 10));
});
sensSlider.addEventListener('change', async () => {
  const v = parseInt(sensSlider.value, 10);
  await chrome.storage.sync.set({ imageScanSensitivity: v });
  setStatus(`Image scan sensitivity: ${sensitivityLabel(v)}`, 'success');
});

// ── Custom sites ─────────────────────────────────────────────────────────────────

addBtn.addEventListener('click', async () => {
  const domain = normalizeDomain(siteInput.value);
  if (!domain) return;
  const s = await getSettings();
  if (s.customBlockedSites.includes(domain)) { setStatus('Already in the list.', 'error'); return; }
  const sites = [...s.customBlockedSites, domain];
  siteInput.value = '';
  await saveSettings({ customBlockedSites: sites });
  reload();
});
siteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
siteList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.list-item-remove');
  if (!btn || btn.disabled) return;
  const s = await getSettings();
  const sites = [...s.customBlockedSites];
  sites.splice(parseInt(btn.dataset.index, 10), 1);
  await saveSettings({ customBlockedSites: sites });
  reload();
});

// ── Keywords ─────────────────────────────────────────────────────────────────────

kwAddBtn.addEventListener('click', async () => {
  const kw = kwInput.value.trim().toLowerCase();
  if (!kw) return;
  const s = await getSettings();
  if (s.blockedKeywords.includes(kw)) { setStatus('Keyword already added.', 'error'); return; }
  const kws = [...s.blockedKeywords, kw];
  kwInput.value = '';
  await saveSettings({ blockedKeywords: kws });
  reload();
});
kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') kwAddBtn.click(); });
kwList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.list-item-remove');
  if (!btn || btn.disabled) return;
  const s = await getSettings();
  const kws = [...s.blockedKeywords];
  kws.splice(parseInt(btn.dataset.index, 10), 1);
  await saveSettings({ blockedKeywords: kws });
  reload();
});

reload();
