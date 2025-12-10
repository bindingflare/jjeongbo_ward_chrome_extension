# 개인정보와드 크롬 익스텐션

MV3 Chrome extension for 개인정보와드 서비스.

## Project layout
- manifest.json
- background.js - service worker for caching, API calls, and overlay injection
- content.js - scans the page for consent-related keywords and reports matches
- popup/
  - popup.html
  - popup.js
  - popup.css
- assets/
  - icon16.png, icon48.png, icon128.png (icon sets)
## Setup
1. Setup ENDPOINT related fields (should already be done)
2. Load the folder as an unpacked extension in Chrome (chrome://extensions > Developer mode > Load unpacked).
3. Visit a page containing 개인정보 동의서 language; the overlay appears automatically on match. Use the popup "Scan page" button to re-run manually.

## Notes
- Permissions: uses `tabs`, `scripting`, and `storage`; host permissions are `<all_urls>` for broad coverage.
- Caching: results are stored in `chrome.storage.local` keyed by a SHA-256 hash of the extracted text (truncated to 5k characters before hashing).
- Free mode: enable it in the popup Settings to send requests to `/api/checkSummary`, show a short result plus “full view” link in overlays, and switch the News tab to simple hyperlinks instead of the embedded reel.
- Overlay: injected into the top-left of the page; it replaces any previous overlay and auto-removes after a few seconds.
- Icons: `manifest.json` references the placeholder PNGs in `assets/`. Replace them with your own (convert `favicon.webp` to 16/48/128 PNGs) if you prefer your brand.
