import { normalizeApplicationKey, normalizeKeyId, validateBackblazeCredentials } from "../lib/b2-credentials.js";
import { DEFAULT_SETTINGS, getBackblazeKeySaved } from "../lib/storage.js";

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  await loadSettings();
  await loadRecords();
  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("test-b2")?.addEventListener("click", testBackblazeUpload);
});

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "records") loadRecords();
    });
  });
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const data = { ...DEFAULT_SETTINGS, ...settings };
  const keySaved = await getBackblazeKeySaved();
  const form = document.getElementById("settings-form");
  form.elements.showCaptureButton.checked = data.showCaptureButton !== false;
  form.elements.autoCapture.checked = data.autoCapture === true;
  form.elements.autoSaveScreenshots.checked = data.autoSaveScreenshots !== false;
  form.elements.autoSaveJson.checked = data.autoSaveJson !== false;
  form.elements.screenshotFolder.value = data.screenshotFolder || "BidTrackScreenshots";
  form.elements.b2Enabled.checked = data.b2Enabled !== false;
  form.elements.b2BucketName.value = data.b2BucketName || "bid-screenshots";
  form.elements.b2BucketId.value = data.b2BucketId || "0f6e97821fb60a18ab150c15";
  form.elements.b2KeyId.value = data.b2KeyId || DEFAULT_SETTINGS.b2KeyId || "005fe72f6a8b5c50000000001";
  form.elements.b2ApplicationKey.value = "";
  form.elements.b2ApplicationKey.placeholder = keySaved
    ? "Saved — leave blank to keep, or paste a new key"
    : "Required: paste application key from Backblaze";
  form.elements.b2KeyPrefix.value = data.b2KeyPrefix || "puma";
  form.elements.b2ProfileName.value = data.b2ProfileName || "upwork";
  form.elements.b2S3Region.value = data.b2S3Region || "us-east-005";
  form.elements.b2S3Endpoint.value = data.b2S3Endpoint || "https://s3.us-east-005.backblazeb2.com";
  updateBackblazeKeyStatus(keySaved);
}

async function saveSettings() {
  const form = document.getElementById("settings-form");
  const newApplicationKey = normalizeApplicationKey(form.elements.b2ApplicationKey.value);
  const b2Enabled = form.elements.b2Enabled.checked;
  const { b2ApplicationKeySecret: previousSecret = "" } = await chrome.storage.local.get(
    "b2ApplicationKeySecret"
  );
  const effectiveKey = newApplicationKey || normalizeApplicationKey(previousSecret);
  const keyId = normalizeKeyId(form.elements.b2KeyId.value.trim() || DEFAULT_SETTINGS.b2KeyId || "");

  const settings = {
    showCaptureButton: form.elements.showCaptureButton.checked,
    autoCapture: form.elements.autoCapture.checked,
    autoSaveScreenshots: form.elements.autoSaveScreenshots.checked,
    autoSaveJson: form.elements.autoSaveJson.checked,
    screenshotFolder: form.elements.screenshotFolder.value.trim() || "BidTrackScreenshots",
    b2Enabled,
    b2BucketName: form.elements.b2BucketName.value.trim() || "bid-screenshots",
    b2BucketId: form.elements.b2BucketId.value.trim() || "0f6e97821fb60a18ab150c15",
    b2KeyId: keyId,
    b2KeyPrefix: form.elements.b2KeyPrefix.value.trim() || "puma",
    b2ProfileName: form.elements.b2ProfileName.value.trim() || "upwork",
    b2UploadApi: "s3",
    b2S3Region: form.elements.b2S3Region.value.trim() || "us-east-005",
    b2S3Endpoint: form.elements.b2S3Endpoint.value.trim() || "https://s3.us-east-005.backblazeb2.com"
  };

  if (b2Enabled) {
    const check = validateBackblazeCredentials({
      b2KeyId: keyId,
      b2ApplicationKey: effectiveKey
    });
    if (!check.ok) {
      setStatus("settings-status", check.error);
      updateBackblazeKeyStatus(false, check.error);
      return;
    }
  }

  if (effectiveKey) {
    await chrome.storage.local.set({ b2ApplicationKeySecret: effectiveKey });
  }

  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({ type: "B2_SETTINGS_CHANGED" }).catch(() => {});
  form.elements.b2ApplicationKey.value = "";
  const keySaved = Boolean(effectiveKey);
  form.elements.b2ApplicationKey.placeholder = keySaved
    ? "Saved — leave blank to keep, or paste a new key"
    : "Required: paste application key from Backblaze";
  const check = validateBackblazeCredentials({ b2KeyId: keyId, b2ApplicationKey: effectiveKey });
  updateBackblazeKeyStatus(check.ok, check.ok ? "" : check.error);
  setStatus("settings-status", check.ok ? "Saved!" : "Saved (Backblaze credentials still invalid).");
}

async function testBackblazeUpload() {
  setStatus("b2-test-status", "Testing…");
  const response = await chrome.runtime.sendMessage({ type: "TEST_B2_UPLOAD" }).catch(() => null);
  if (response?.ok) {
    setStatus("b2-test-status", response.message || "Backblaze upload OK");
    return;
  }
  setStatus("b2-test-status", response?.error || "Backblaze test failed");
}

function updateBackblazeKeyStatus(keySaved, detail = "") {
  const el = document.getElementById("b2-key-status");
  if (!el) return;
  if (keySaved) {
    el.textContent = "Backblaze credentials look valid (Key ID 005… and secret K005…).";
    el.className = "hint ok";
    return;
  }
  el.textContent =
    detail ||
    "Paste the application key secret (K005…) below, confirm Key ID (005…), then Save Settings.";
  el.className = "hint warn";
}

async function loadRecords() {
  const list = document.getElementById("records-list");
  const response = await chrome.runtime.sendMessage({ type: "GET_RECORDS" });
  const records = response?.records || [];

  if (!records.length) {
    list.innerHTML =
      '<div class="empty-state">No application records yet. Open a job page and click the Save button before each step.</div>';
    return;
  }

  list.innerHTML = records
    .map((record) => {
      const captures = record.captures || [];
      return `
      <article class="record-card" data-id="${record.id}">
        <h3>${escapeHtml(record.title || "Untitled Job")}</h3>
        <div class="record-meta">
          <div><strong>Job link:</strong> <a href="${escapeHtml(record.url)}" target="_blank">${escapeHtml(record.url)}</a></div>
          <div><strong>Save folder:</strong> Downloads/${escapeHtml(record.downloadFolder || "BidTrackScreenshots")}</div>
          <div><strong>Status:</strong> ${escapeHtml(record.status)}</div>
          <div><strong>Screenshots:</strong> ${captures.length}</div>
          <div><strong>Created:</strong> ${formatDate(record.createdAt)}</div>
          ${record.submittedAt ? `<div><strong>Submitted:</strong> ${formatDate(record.submittedAt)}</div>` : ""}
          ${record.jsonFileName ? `<div><strong>JSON file:</strong> ${escapeHtml(record.jsonFileName)}</div>` : ""}
        </div>
        ${
          record.jobDescription
            ? `<details><summary>Job Description</summary><div class="record-fields">${escapeHtml(record.jobDescription.slice(0, 2000))}${record.jobDescription.length > 2000 ? "..." : ""}</div></details>`
            : ""
        }
        ${
          captures.length
            ? `<details open><summary>Screenshots (${captures.length})</summary><div class="record-fields">${captures
                .map(
                  (item) =>
                    `<div style="margin-bottom:8px"><strong>Step ${item.step}</strong> · ${escapeHtml(item.trigger)} · ${escapeHtml(item.b2FileName || item.screenshotFileName || "saved")}${item.b2Error ? ` · upload failed: ${escapeHtml(item.b2Error)}` : ""}</div>`
                )
                .join("")}</div></details>`
            : ""
        }
        ${
          record.latestScreenshotDataUrl
            ? `<img class="record-screenshot" src="${record.latestScreenshotDataUrl}" alt="Latest screenshot" />`
            : ""
        }
        <div class="record-actions">
          ${record.jsonFileName ? `<button class="btn secondary" data-download-json="${record.id}">Download JSON</button>` : ""}
          ${
            captures.length
              ? `<button class="btn secondary" data-download="${record.id}" data-capture="${captures[captures.length - 1].id}">Download Latest Screenshot</button>`
              : ""
          }
          <button class="btn danger" data-delete="${record.id}">Delete</button>
        </div>
      </article>
    `;
    })
    .join("");

  list.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this record?")) return;
      await chrome.runtime.sendMessage({ type: "DELETE_RECORD", payload: { id: btn.dataset.delete } });
      loadRecords();
    });
  });

  list.querySelectorAll("[data-download]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "DOWNLOAD_SCREENSHOT",
        payload: {
          recordId: btn.dataset.download,
          captureId: btn.dataset.capture
        }
      });
    });
  });

  list.querySelectorAll("[data-download-json]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "DOWNLOAD_JSON",
        payload: { id: btn.dataset.downloadJson }
      });
    });
  });
}

function setStatus(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  setTimeout(() => {
    el.textContent = "";
  }, 2000);
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
