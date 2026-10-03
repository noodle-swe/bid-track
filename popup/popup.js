import { getAuth, register, login, logout, me, ApiError } from "../lib/api.js";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  $("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  $("refresh").addEventListener("click", loadStatus);
  $("tab-register").addEventListener("click", () => showTab("register"));
  $("tab-login").addEventListener("click", () => showTab("login"));
  $("form-register").addEventListener("submit", (e) =>
    submitAuth(e, () => register($("reg-code").value.trim(), $("reg-username").value.trim(), $("reg-password").value))
  );
  $("form-login").addEventListener("submit", (e) =>
    submitAuth(e, () => login($("login-username").value.trim(), $("login-password").value))
  );
  $("logout").addEventListener("click", async () => {
    await logout();
    await render();
  });
  await render();
});

async function render() {
  let auth = await getAuth();
  if (auth) {
    // Refresh the header. A 401 clears auth and sets the notice; other errors
    // (offline, server down) keep the cached bidder.
    await me().catch(() => null);
    auth = await getAuth();
  }
  if (auth) showLoggedIn(auth.bidder);
  else await showLoggedOut();
}

function showLoggedIn(bidder) {
  $("auth").classList.add("hidden");
  $("main").classList.remove("hidden");
  $("logout").classList.remove("hidden");
  const line = $("account-line");
  line.textContent = `${bidder.name} · ${bidder.profileName || "No profile"} · uploading to ${bidder.folder}/`;
  line.classList.remove("hidden");
  loadStatus();
}

async function showLoggedOut() {
  $("main").classList.add("hidden");
  $("logout").classList.add("hidden");
  $("account-line").classList.add("hidden");
  $("auth").classList.remove("hidden");
  setError("");
  const { authNotice } = await chrome.storage.local.get("authNotice");
  const noticeEl = $("auth-notice");
  noticeEl.textContent = authNotice || "";
  noticeEl.classList.toggle("hidden", !authNotice);
}

function showTab(which) {
  const isRegister = which === "register";
  $("tab-register").classList.toggle("active", isRegister);
  $("tab-login").classList.toggle("active", !isRegister);
  $("tab-register").setAttribute("aria-selected", String(isRegister));
  $("tab-login").setAttribute("aria-selected", String(!isRegister));
  $("form-register").classList.toggle("hidden", !isRegister);
  $("form-login").classList.toggle("hidden", isRegister);
  setError("");
}

function setError(message) {
  const el = $("auth-error");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

async function submitAuth(event, action) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setError("");
  try {
    await action(); // register()/login() clear authNotice on success
    form.reset();
    await render();
  } catch (err) {
    setError(err instanceof ApiError ? err.message : "Could not reach the server. Check Settings > Server URL.");
  } finally {
    button.disabled = false;
  }
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
