import { getServerUrl, setServerUrl } from "../lib/api.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  await loadSettings();
  document.getElementById("server-url").value = await getServerUrl();
  await loadRecords();
  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("save-server-url").addEventListener("click", saveServerUrl);
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
  const form = document.getElementById("settings-form");
  form.elements.showCaptureButton.checked = data.showCaptureButton !== false;
  form.elements.autoCapture.checked = data.autoCapture === true;
  form.elements.autoSaveScreenshots.checked = data.autoSaveScreenshots !== false;
  form.elements.autoSaveJson.checked = data.autoSaveJson !== false;
  form.elements.screenshotFolder.value = data.screenshotFolder || "BidTrackScreenshots";
}

async function saveSettings() {
  const form = document.getElementById("settings-form");
  const settings = {
    showCaptureButton: form.elements.showCaptureButton.checked,
    autoCapture: form.elements.autoCapture.checked,
    autoSaveScreenshots: form.elements.autoSaveScreenshots.checked,
    autoSaveJson: form.elements.autoSaveJson.checked,
    screenshotFolder: form.elements.screenshotFolder.value.trim() || "BidTrackScreenshots"
  };
  await chrome.storage.local.set({ settings });
  setStatus("settings-status", "Saved!");
}

async function saveServerUrl() {
  const input = document.getElementById("server-url");
  await setServerUrl(input.value);
  input.value = await getServerUrl();
  setStatus("server-url-status", "Saved!");
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
