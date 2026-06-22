'use strict';

// SafeGuard on-device image scanner.
// Injected on demand (after tf.min.js + nsfwjs.min.js) into a single tab the
// gate flagged as borderline. Loads the bundled MobileNetV2 model, classifies
// the most prominent images on the page, and blocks if adult content is found.
//
// Guard against double-injection: scripting.executeScript can re-run this file.
(async () => {
  if (window.__safeguardScanRan) return;
  window.__safeguardScanRan = true;

  const MAX_IMAGES      = 8;     // only the largest few — keeps it fast
  const MIN_DIMENSION   = 128;   // ignore icons / thumbnails / sprites

  if (typeof nsfwjs === 'undefined') {
    console.warn('[SafeGuard] scanner lib missing');
    return;
  }

  // Sensitivity (0 = lenient, 100 = strict). Maps to detection thresholds:
  // higher sensitivity → lower probability needed to flag an image.
  let sensitivity = 50;
  try {
    const s = await chrome.storage.sync.get({ imageScanSensitivity: 50 });
    sensitivity = s.imageScanSensitivity;
  } catch {}
  const PORN_THRESHOLD = 0.90 - (sensitivity / 100) * 0.60;          // 0.90 → 0.30
  const SEXY_THRESHOLD = Math.min(0.97, PORN_THRESHOLD + 0.25);      // a touch stricter
  console.info(`[SafeGuard] image scan sensitivity ${sensitivity} → porn≥${PORN_THRESHOLD.toFixed(2)}, sexy≥${SEXY_THRESHOLD.toFixed(2)}`);

  // nsfwjs bundles its own TensorFlow.js and selects a backend (WebGL) itself.
  let model;
  try {
    // Bundled model directory (trailing slash → nsfwjs appends model.json).
    const modelUrl = chrome.runtime.getURL('models/nsfw/model.json');
    model = await nsfwjs.load(modelUrl, { size: 224 });
  } catch (e) {
    console.warn('[SafeGuard] model load failed:', e);
    return;
  }

  // Collect the most prominent, loaded, sufficiently large images.
  function collectImages() {
    return Array.from(document.images)
      .filter((img) =>
        img.complete &&
        img.naturalWidth  >= MIN_DIMENSION &&
        img.naturalHeight >= MIN_DIMENSION)
      .sort((a, b) =>
        (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))
      .slice(0, MAX_IMAGES);
  }

  function isAdult(predictions) {
    const p = Object.fromEntries(predictions.map((x) => [x.className, x.probability]));
    const pornish = (p.Porn || 0) + (p.Hentai || 0);
    if (pornish >= PORN_THRESHOLD) return true;
    if ((p.Sexy || 0) >= SEXY_THRESHOLD) return true;
    return false;
  }

  async function scan() {
    const images = collectImages();
    if (!images.length) return false;

    for (const img of images) {
      try {
        const preds = await model.classify(img);
        if (isAdult(preds)) {
          console.info('[SafeGuard] adult image detected:',
            preds.map((x) => `${x.className} ${(x.probability * 100).toFixed(0)}%`).join(', '));
          return true;
        }
      } catch (_) {
        // Cross-origin images taint the canvas and can't be read — skip them.
      }
    }
    return false;
  }

  // Immediately mask the page so nothing flashes while we classify.
  const veil = document.createElement('div');
  veil.style.cssText =
    'position:fixed;inset:0;background:rgba(11,17,32,0.001);z-index:2147483646;pointer-events:none;';
  document.documentElement.appendChild(veil);

  let flagged = await scan();

  // Images may still be loading — give it one short retry.
  if (!flagged) {
    await new Promise((r) => setTimeout(r, 1200));
    flagged = await scan();
  }

  veil.remove();

  if (flagged) {
    // Blur instantly for feedback, then hand off to the background worker to
    // record the block and redirect this tab to the styled blocked page.
    document.documentElement.style.filter = 'blur(28px)';
    document.documentElement.style.pointerEvents = 'none';
    chrome.runtime.sendMessage({
      type: 'NSFW_CONFIRMED',
      host: location.hostname.replace(/^www\./, ''),
    }).catch(() => {});
  }

  // Free GPU memory — we don't keep the model resident.
  try { if (model && model.model) model.model.dispose(); model = null; } catch {}
})();
