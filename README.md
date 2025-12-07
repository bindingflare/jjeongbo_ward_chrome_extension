# Privacy Agreement Checker (template)

A minimal MV3 Chrome extension that detects 개인정보 동의서 text on a page, sends it to a backend API for analysis, caches the result locally, and shows a small overlay on the page. The popup lets you trigger a manual scan.

## Project layout
- manifest.json
- background.js - service worker for caching, API calls, and overlay injection
- content.js - scans the page for consent-related keywords and reports matches
- popup/
  - popup.html
  - popup.js
  - popup.css
- assets/
  - icon16.png, icon48.png, icon128.png (placeholder set; swap with your own)
  - favicon.webp (original source asset; convert to PNG if you want to reuse it)

## Setup
1. In `background.js`, set `API_URL` to your backend endpoint and ensure it allows CORS for extension requests.
2. Load the folder as an unpacked extension in Chrome (chrome://extensions > Developer mode > Load unpacked).
3. Visit a page containing 개인정보 동의서 language; the overlay appears automatically on match. Use the popup "Scan page" button to re-run manually.

## Notes
- Permissions: uses `tabs`, `scripting`, and `storage`; host permissions are `<all_urls>` for broad coverage. Narrow them if you prefer.
- Caching: results are stored in `chrome.storage.local` keyed by a SHA-256 hash of the extracted text (truncated to 5k characters before hashing).
- Overlay: injected into the top-left of the page; it replaces any previous overlay and auto-removes after a few seconds.
- Icons: `manifest.json` references the placeholder PNGs in `assets/`. Replace them with your own (convert `favicon.webp` to 16/48/128 PNGs) if you prefer your brand.
