# Bid Track

Full-page screenshots of job applications. When you are logged in, each PNG is uploaded to your Bid Track folder
through a short-lived signed link from the Engineers backend; the extension holds no storage keys. A copy can also
be saved to Chrome Downloads.

## Install

Remove any older "Bid Track Local" extension first (or unzip this version over its folder and click Reload). Two
copies side by side double-count or lose bids.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select this folder

## Use

Everything is in the window that opens when you click the extension icon.

- **Log in** with your username and password. The first time, also enter the invite code your manager sent you —
  that registers you (username: 3–40 letters, numbers, `.`, `_` or `-`; password: at least 8 characters).
- **Upload Screenshot** saves a full-page screenshot of the job page in the current tab and uploads it. Click it
  for each step of an application (before Next, and before Submit). The line under the button shows the result.
- **Automatically download the screenshots to local** also saves each PNG to
  `Downloads/BidTrackScreenshots/<job-folder>/` (with a `job-info.json` for the job).
- Each application (all the screenshots of one job page) is recorded as a bid that your manager reviews.
- **Log out** next to your username.

## Server

The extension talks to `https://engineersbackend-production.up.railway.app`. For a test server, open the popup,
right-click → Inspect, and run in the console:

```js
chrome.storage.local.set({ serverUrl: "http://localhost:8082" })   // test server
chrome.storage.local.remove("serverUrl")                           // back to production
```
