'use strict';
const params = new URLSearchParams(location.search);
const site   = params.get('site');
const reason = params.get('reason');

if (site) document.getElementById('siteName').textContent = site;

const reasons = {
  adult:      { label: 'Adult Content',        cls: '' },
  blocklist:  { label: 'Community Blocklist',  cls: '' },
  classifier: { label: 'Flagged by Filter',    cls: '' },
  image:      { label: 'Adult Image Detected', cls: '' },
  keyword:    { label: 'Blocked Keyword',      cls: 'reason-custom' },
  custom:     { label: 'Blocked Site',         cls: 'reason-custom' },
};
const r = reasons[reason] || { label: 'Blocked Site', cls: 'reason-custom' };
document.getElementById('reasonText').textContent = r.label;
document.getElementById('reasonBadge').className  = 'reason-badge ' + r.cls;

const today = parseInt(params.get('today') || '0', 10);
if (today > 0) {
  document.getElementById('blockStat').innerHTML =
    `That's <b>${today}</b> distraction${today !== 1 ? 's' : ''} blocked today.`;
}

document.getElementById('backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = 'chrome://newtab';
});
