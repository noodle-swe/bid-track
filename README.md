# Bid Track

Full-page screenshots and JSON metadata saved to **Chrome Downloads**. When you are logged in, each PNG is also uploaded to your Bid Track folder through a short-lived signed link from the Engineers backend. The extension holds no storage keys.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select this folder
4. Click the extension icon and register with the invite code your manager sent you (choose a username and a password of at least 8 characters). If you are not logged in, screenshots are still saved locally, but they do not count as bids.

## Settings

- **Downloads root folder**, default `BidTrackScreenshots`
- Auto-download PNG / JSON toggles
- **Advanced → Server URL**, default `https://engineersbackend-production.up.railway.app`. Change it only for a test server; blank restores the default.

Files appear under:

`Downloads/{root}/{job-folder}/step1_....png` and `job-info.json`

## Test

Open `test/test-multistep.html` (enable file URL access for the extension if needed).
