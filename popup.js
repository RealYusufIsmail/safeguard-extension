'use strict';

const $ = (id) => document.getElementById(id);

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
const kwLock           = $('kwLock');
const confirmDialog    = $('confirmDialog');
const confirmSite      = $('confirmSite');
const confirmCancel    = $('confirmCancel');
const confirmBlock     = $('confirmBlock');

let focusTimer = null;
let pendingSite = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg, type = 'idle') {
  statusBar.className = 'status-bar' + (type !== 'idle' ? ' ' + type : '');
  statusText.textContent = msg;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function normalizeDomain(s) {
  const value = s.trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
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
// ── Settings access ───────────────────────────────────────────────────────────

function getSettings() {
  return chrome.storage.sync.get({
    customBlockedSites: [],
    permanentBlockedSites: [],
    blockedKeywords:    [],
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
  kwLock.classList.toggle('show', active);

  // New safeguards can always be added. Existing keywords cannot be removed
  // during a focus session; permanent sites never have a removal control.
  kwList.querySelectorAll('.list-item-remove').forEach((b) => (b.disabled = active));

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
    await chrome.storage.sync.set({ focusUntil: until });
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

  const statsEl = $('sourceStats');
  if (!statsEl) return;
  const stats = meta.sourceStats || {};
  const names = Object.keys(stats);
  if (!names.length) { statsEl.innerHTML = ''; return; }
  statsEl.innerHTML = names.map(name => {
    const count = stats[name];
    const ok = count > 0;
    return `<div class="source-row">
      <span class="src-name"><span class="source-dot${ok ? '' : ' err'}"></span>${name}</span>
      <span class="source-count">${ok ? formatCount(count) : 'failed'}</span>
    </div>`;
  }).join('');
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
    const suffix = r.warnings?.length ? ' (some sources unavailable)' : '';
    setStatus(`Blocklist updated — ${r.count.toLocaleString()} domains${suffix}`, r.warnings?.length ? 'error' : 'success');
  } else {
    setStatus('Sync failed: ' + (r.error || 'unknown'), 'error');
  }
});

// ── List rendering ───────────────────────────────────────────────────────────

function renderList(el, items, emptyMsg, removable = true) {
  el.innerHTML = '';
  if (!items.length) { el.innerHTML = `<div class="empty-state">${emptyMsg}</div>`; return; }
  items.forEach((val, i) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const action = removable
      ? `<button class="list-item-remove" data-index="${i}" title="Remove">✕</button>`
      : `<svg class="list-item-lock" viewBox="0 0 24 24" fill="none" aria-label="Permanent">
          <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.7"/>
          <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7"/>
        </svg>`;
    row.innerHTML = `<span class="list-item-name">${escapeHtml(val)}</span>${action}`;
    el.appendChild(row);
  });
}

// ── Main render ─────────────────────────────────────────────────────────────────

async function reload() {
  const s = await getSettings();
  const permanentSites = [...new Set([...s.customBlockedSites, ...s.permanentBlockedSites])];
  renderList(siteList, permanentSites, 'No custom sites blocked yet.', false);
  renderList(kwList, s.blockedKeywords, 'No keywords blocked yet.');
  renderFocus(s);                    // applies locks after lists render
  await refreshStats();
  await refreshBlocklistMeta();
  if (!focusActive(s)) {
    const c = permanentSites.length;
    setStatus(`Active — ${c} site${c !== 1 ? 's' : ''}, ${s.blockedKeywords.length} keyword${s.blockedKeywords.length !== 1 ? 's' : ''}`, 'success');
  }
}

// ── Custom sites ─────────────────────────────────────────────────────────────────

addBtn.addEventListener('click', () => {
  const domain = normalizeDomain(siteInput.value);
  if (!domain) {
    setStatus('Enter a valid website, such as example.com.', 'error');
    return;
  }
  pendingSite = domain;
  confirmSite.textContent = domain;
  confirmDialog.showModal();
});

confirmCancel.addEventListener('click', () => {
  pendingSite = null;
  confirmDialog.close();
  siteInput.focus();
});

confirmDialog.addEventListener('cancel', () => {
  pendingSite = null;
});

confirmBlock.addEventListener('click', async () => {
  const domain = pendingSite;
  if (!domain) return;
  const s = await getSettings();
  const existing = new Set([...s.customBlockedSites, ...s.permanentBlockedSites]);
  if (existing.has(domain)) {
    pendingSite = null;
    confirmDialog.close();
    setStatus('That website is already permanently blocked.', 'error');
    return;
  }
  const sites = [...s.permanentBlockedSites, domain];
  siteInput.value = '';
  pendingSite = null;
  confirmDialog.close();
  await saveSettings({ permanentBlockedSites: sites });
  await reload();
  setStatus(`${domain} is now permanently blocked.`, 'success');
});
siteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

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
