document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("refresh").addEventListener("click", loadStatus);
  document.getElementById("pin-panel").addEventListener("click", pinSidePanel);
  await loadStatus();
});

async function pinSidePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel/sidepanel.html",
    enabled: true
  });
  await chrome.sidePanel.open({ tabId: tab.id });
}

async function loadStatus() {
  const statusEl = document.getElementById("tracking-status");
  const recordSection = document.getElementById("current-record");
  const previewEl = document.getElementById("record-preview");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusEl.textContent = "No active tab found.";
    statusEl.className = "status-card inactive";
    return;
  }

  const host = tab.url ? new URL(tab.url).hostname : "";
  const excluded = /linkedin\.com|indeed\.com/i.test(host);

  if (excluded) {
    statusEl.innerHTML = `<strong>Excluded site</strong><br>${host}<br>LinkedIn and Indeed are not tracked.`;
    statusEl.className = "status-card inactive";
    recordSection.classList.add("hidden");
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "PING" }).catch(() => null);

  if (!response) {
    statusEl.innerHTML = `<strong>Page not ready</strong><br>Reload the job page after installing Bid Track.`;
    statusEl.className = "status-card inactive";
  } else {
    statusEl.innerHTML = `<strong>Tracking enabled</strong><br>${host}<br>${response.stepCount || 0} screenshot(s) captured`;
    statusEl.className = "status-card active";
  }

  const recordRes = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_RECORD" });
  const record = recordRes?.record;

  if (record) {
    recordSection.classList.remove("hidden");
    const capturesHtml = (record.captures || []).length
      ? `<div class="capture-block"><strong>Screenshots</strong>${record.captures
          .map(
            (item) =>
              `<div class="capture-item">Step ${item.step} · ${escapeHtml(item.trigger)} · ${escapeHtml(item.screenshotFileName || "saved")}</div>`
          )
          .join("")}</div>`
      : `<div class="capture-block">No screenshots yet. Click Save on the job page before each step.</div>`;

    previewEl.innerHTML = `
      <div><strong>Title:</strong> ${escapeHtml(record.title || "Untitled")}</div>
      <div><strong>Company:</strong> ${escapeHtml(record.companyName || "Unknown")}</div>
      <div><strong>Job link:</strong> ${escapeHtml(record.url)}</div>
      <div><strong>Save folder:</strong> Downloads/${escapeHtml(record.downloadFolder || "BidTrackScreenshots")}</div>
      <div><strong>Status:</strong> ${escapeHtml(record.status)}</div>
      <div><strong>Description:</strong> ${escapeHtml((record.jobDescription || "Not detected yet").slice(0, 240))}${(record.jobDescription || "").length > 240 ? "..." : ""}</div>
      ${capturesHtml}
    `;
  } else {
    recordSection.classList.add("hidden");
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
