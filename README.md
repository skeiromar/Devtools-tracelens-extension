# TraceLens Extension

TraceLens is a Chrome DevTools extension for capturing high-signal API traffic, reviewing the requests in a dedicated panel, and exporting a clean JSON session for downstream analysis.

This repository was seeded from [Chrome-Extension-Boilerplate-React-Vite](https://github.com/ThomasKiljanczykDev/Chrome-Extension-Boilerplate-React-Vite) and then reshaped into a DevTools-first product.

## V1 Shape

Open DevTools, switch to the `TraceLens` panel, click `Start Capture`, use the site, then click `Stop` and `Export JSON`.

Captured fields:

- method
- url
- status
- mime type
- request headers summary
- response headers summary
- timing
- request body preview when available
- response body preview when available
- body size
- resource type
- timestamp

The capture pipeline aggressively ignores common noise such as images, fonts, stylesheets, analytics, tracking pixels, source maps, favicons, and obvious binary assets.

## Local Development

1. Install dependencies with `yarn install`.
2. Build with `yarn build`.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked` and choose the generated `dist` folder.
6. Open DevTools on any site and use the `TraceLens` panel.

## Notes

- Sessions are persisted in `chrome.storage.local`, scoped by the inspected tab ID.
- Export uses the Chrome downloads API and produces files like `tracelens-session-2026-04-24.json`.
- WebSocket capture is intentionally left for a later version.

## Boilerplate Credit

- [Thomas Kiljańczyk's Chrome Extension Boilerplate](https://github.com/ThomasKiljanczykDev/Chrome-Extension-Boilerplate-React-Vite)
