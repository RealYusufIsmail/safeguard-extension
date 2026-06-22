'use strict';

// SafeGuard content gate — runs on every page but stays extremely cheap.
// It only decides WHETHER to spend the heavy on-device image scan; it never
// loads any model itself. If a page looks borderline, it asks the background
// worker to lazy-inject the NSFWJS scanner into this tab only.

(async () => {
  // Soft signals — words that hint at adult content without being conclusive.
  const SOFT = /(porn|p0rn|xxx|sex|nsfw|nude|naked|adult|escort|hentai|fetish|camgirl|webcam|milf|boob|onlyfans|erotic|hardcore|softcore|18\+)/i;

  // Skip extension pages, blank tabs, and non-http(s) schemes.
  if (!/^https?:$/.test(location.protocol)) return;

  let settings;
  try {
    settings = await chrome.storage.sync.get({
      adultBlockEnabled: true,
      imageScanEnabled:  true,
    });
  } catch { return; }

  if (!settings.adultBlockEnabled || !settings.imageScanEnabled) return;

  function evaluateGate() {
    // 1. URL classifier — gray zone (suspicious but under the hard-block bar).
    let urlScore = 0;
    try { urlScore = (classifyURL(location.href) || {}).score || 0; } catch {}

    // 2. Cheap DOM text signals.
    const title = document.title || '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content || '';
    const ogType = document.querySelector('meta[property="og:type"]')?.content || '';

    const textHit = SOFT.test(title) || SOFT.test(metaDesc) || SOFT.test(location.href);

    // 3. Require a real suspicion before we wake the model — keeps it from
    //    ever running on normal browsing (news, mail, shopping, etc.).
    const suspicious =
      urlScore >= 4 ||           // gray-zone URL tokens
      textHit ||                 // adult-ish words in title/meta/url
      /video|adult/i.test(ogType);

    if (suspicious) {
      chrome.runtime.sendMessage({ type: 'NSFW_SCAN_REQUEST' }).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', evaluateGate, { once: true });
  } else {
    evaluateGate();
  }
})();
