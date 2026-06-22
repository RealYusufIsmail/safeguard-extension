# SafeGuard — Content & Site Blocker

A Chrome extension that blocks adult content and custom websites using multiple detection layers — from fast domain lists through to an on-device AI image scanner.

## Features

| Layer | How it works | Cost |
|---|---|---|
| **Known domain list** | 30+ hardcoded adult domains | ~0 ms |
| **Custom site blocker** | Block any domain you add | ~0 ms |
| **Keyword blocker** | Block any URL containing a word | ~0 ms |
| **Community blocklist** | 12 000 domains synced from [Steven Black](https://github.com/StevenBlack/hosts) every 24 h | ~0 ms |
| **TF-IDF URL classifier** | Pre-baked model scores URL tokens for adult patterns | < 0.1 ms |
| **NSFWJS image scanner** | MobileNetV2 on-device model, only injected on suspect pages | 20–50 ms/img, GPU |

### Popup controls

- **Block Adult Content** — master toggle for all adult-content detection
- **Smart URL Classifier** — on/off switch for the TF-IDF URL scorer
- **On-Device Image Scan** — on/off switch for the NSFWJS model
- **Scan sensitivity slider** — tune from *Lenient* to *Very strict*
- **Focus Mode** — 30 min / 1 h / 2 h lock that disables all off-switches so you can't bypass blocks mid-session
- **Community Blocklist** — shows domain count + last sync time; Sync Now button
- **Custom Blocked Sites** — add/remove domains
- **Blocked Keywords** — add/remove keyword strings
- **Stats** — *Blocked Today* and *All Time* counters; badge on the toolbar icon

## Screenshots

> Add screenshots here once the extension is published.

## Installation

### From source (developer mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/RealYusufIsmail/safeguard-extension.git
   cd safeguard-extension
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. The SafeGuard icon appears in your toolbar

### Incognito support

By default extensions don't run in incognito windows. To enable it:

1. `chrome://extensions` → SafeGuard → **Details**
2. Toggle **Allow in Incognito** on

## Project structure

```
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — all blocking decisions
├── classifier.js          # TF-IDF URL classifier (shared: SW + content script)
├── blocklist-sync.js      # Community blocklist fetch & storage
├── content.js             # Lightweight gate — runs on every page
├── nsfw-scan.js           # On-device image scanner (injected on demand)
├── popup.html / popup.js  # Extension popup UI
├── blocked.html / .js     # Blocked page shown when a site is intercepted
├── rules/
│   └── adult_block_rules.json   # Static declarativeNetRequest rules
├── models/nsfw/           # Bundled MobileNetV2 model weights (~2.7 MB)
└── vendor/
    └── nsfwjs.min.js      # NSFWJS standalone bundle (TF.js included, ~2.7 MB)
```

## How the image scanner works

The scanner is designed to have near-zero battery and memory cost on normal browsing:

1. `content.js` runs on every page — it only evaluates cheap signals (URL classifier score + title/meta keywords). Takes microseconds.
2. If a page looks borderline, it tells the background worker via a message.
3. The background worker uses `chrome.scripting.executeScript` to inject `nsfwjs.min.js` + `nsfw-scan.js` into **that tab only**.
4. The scanner classifies the largest images on the page using MobileNetV2 on the GPU, then disposes the model immediately.
5. If adult content is detected the tab is redirected to the blocked page.

Normal pages (news, email, shopping) never trigger step 2 and the model is never loaded.

### Sensitivity mapping

| Setting | Porn + Hentai threshold | Behaviour |
|---|---|---|
| Lenient (0) | ≥ 90 % | Only blatant content |
| Balanced (50, default) | ≥ 60 % | Sensible middle ground |
| Very strict (100) | ≥ 30 % | Catches borderline/suggestive content |

## Privacy

- No data leaves your device. All detection runs locally.
- The community blocklist is fetched from a public GitHub URL once per day — no identifiable data is sent.
- No analytics, no telemetry.

## Contributing

Pull requests are welcome. For major changes please open an issue first.

## License

[MIT](LICENSE) © 2025 Yusuf Arfan Ismail
