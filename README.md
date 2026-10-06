# Bid Track

Full-page screenshots of job applications. When you are logged in, each screenshot (WebP, about 14× smaller than PNG) is uploaded to your Bid Track folder
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
- **Capture bid** / **Capture step N** saves a full-page screenshot of the job page in the current tab and uploads
  it; the line under it shows which job it is filed under. On a one-page application form the button says
  **Capture bid**: click it once before Submit. On a multi-step application (a Next/Continue button or a
  "Step 2 of 5" indicator; Workday, iCIMS, Taleo and similar) it says **Capture step N**: click it on each step,
  before Next and before Submit. Steps are counted per bidder and start again at 1 each day. The result appears
  in the bottom-right corner of the job page (green: uploaded, gone after a few seconds; red: not uploaded, stays
  until closed) and on the toolbar icon (a red **!** stays until the next upload works).
- **Keyboard shortcut: Alt+Shift+S** does the same as the button, without opening the window.
- Each application (all the screenshots of one job page) is recorded as a bid that your manager reviews.
- **Settings** (next to Log out):
  - **Change password**: current password, then the new one twice. Other browsers using your login are logged out.
    Your username is set by your manager and can't be changed here.
  - **Change shortcut** opens Chrome's shortcut page (`chrome://extensions/shortcuts`), the only place Chrome
    allows it.
  - **Automatically download the screenshots to local** also saves each screenshot to
    `Downloads/BidTrackScreenshots/<job-folder>/`.
- **Log out** next to your username.

## Server

The extension talks to `https://engineersbackend-production-902c.up.railway.app`. For a test server, open the popup,
right-click → Inspect, and run in the console:

```js
chrome.storage.local.set({ serverUrl: "http://localhost:8080" })   // local backend
chrome.storage.local.remove("serverUrl")                           // back to production
```
