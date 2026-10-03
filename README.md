# Bid Track Local

Full-page screenshots and JSON metadata saved to **Chrome Downloads**, with each PNG also uploaded to **Backblaze B2**.

Backblaze does not create date folders. The extension writes the local date into the object key and the file name:

`puma/2026-10-03/upwork/job-name/step1_step_2026-10-03_093015.png` (member / date / profile / job)

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder: `Bid Track Local`
4. You can keep **Bid Track** (cloud) loaded at the same time — they are separate extensions with separate storage.

## Settings

- **Downloads root folder** — default `BidTrackScreenshots`
- Auto-download PNG / JSON toggles
- **Backblaze** — bucket `bid-screenshots`, bucket ID `0f6e97821fb60a18ab150c15`, prefix `puma/`, upload on by default (native B2 API; S3 endpoint `s3.us-east-005.backblazeb2.com` is not used by this extension)

Files appear under:

`Downloads/{root}/{job-folder}/step1_....png` and `job-info.json`

## Test

Open `test/test-multistep.html` (enable file URL access for the extension if needed).
