import { getAuth, register, login, logout, me, changePassword, ApiError } from "../lib/api.js";
import { stepOwnerKey, stepsTaken } from "../lib/storage.js";
import { resolveApplyFlow } from "../lib/job-platform.js";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  $("auth-form").addEventListener("submit", submitAuth);
  $("invite-input").addEventListener("input", () => {
    $("auth-submit").textContent = $("invite-input").value.trim() ? "Register" : "Log in";
  });
  $("logout").addEventListener("click", async () => {
    await logout();
    await render();
  });
  $("upload").addEventListener("click", uploadScreenshot);
  $("auto-download").addEventListener("change", saveAutoDownload);
  $("open-settings").addEventListener("click", () => showView("settings"));
  $("close-settings").addEventListener("click", () => showView("main"));
  $("password-form").addEventListener("submit", submitPasswordChange);
  // Chrome only lets its own page change an extension's shortcut.
  $("change-shortcut").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  await render();
});

// "main" (capture) or "settings", for a logged-in bidder.
function showView(view) {
  $("main").classList.toggle("hidden", view !== "main");
  $("settings").classList.toggle("hidden", view !== "settings");
  $("open-settings").classList.toggle("hidden", view === "settings");
  $("settings-sep").classList.toggle("hidden", view === "settings");
  if (view === "settings") {
    setText("password-result", "");
    showShortcut();
  }
}

async function render() {
  let auth = await getAuth();
  if (auth) {
    // A 401 here clears auth and sets the notice; offline or server errors keep the cached login.
    await me().catch(() => null);
    auth = await getAuth();
  }
  const loggedIn = !!auth?.bidder;
  $("auth").classList.toggle("hidden", loggedIn);
  $("account").classList.toggle("hidden", !loggedIn);

  if (loggedIn) {
    showView("main");
    const name = auth.bidder.username || auth.bidder.name || "";
    $("username").textContent = name;
    $("settings-username").textContent = name;
    const { settings = {} } = await chrome.storage.local.get("settings");
    $("auto-download").checked = settings.autoSaveScreenshots !== false;
    setText("result", "");
    await showNextStep();
    return;
  }
  $("main").classList.add("hidden");
  $("settings").classList.add("hidden");
  const { authNotice } = await chrome.storage.local.get("authNotice");
  setText("auth-notice", authNotice || "");
  setText("auth-error", "");
}

async function submitAuth(event) {
  event.preventDefault();
  const button = $("auth-submit");
  const username = $("username-input").value.trim();
  const password = $("password-input").value;
  const inviteCode = $("invite-input").value.trim();
  button.disabled = true;
  setText("auth-error", "");
  try {
    if (inviteCode) await register(inviteCode, username, password);
    else await login(username, password);
    event.target.reset();
    $("auth-submit").textContent = "Log in";
    await render();
  } catch (err) {
    setText("auth-error", err instanceof ApiError ? err.message : "Something went wrong — try again");
  } finally {
    button.disabled = false;
  }
}

// "Capture step N" on a multi-step application, "Capture bid" on a one-page form, with the job it is filed under.
async function showNextStep() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_RECORD" }).catch(() => null);
  const record = response?.record;
  const taken = stepsTaken(record, stepOwnerKey((await getAuth())?.bidder));
  const flow = resolveApplyFlow(record?.applyFlow, await pageApplyFlow(tab?.id), record?.url || tab?.url);
  $("upload").textContent =
    flow === "multi" ? `Capture step ${taken + 1}` : taken ? "Capture bid again" : "Capture bid";
  setText("job", record ? jobLine(record.companyName, record.title) : "");
}

// "multi", "single" or "unknown" from the page script, across frames (a form can sit in an iframe). Never injects:
// a tab the page script isn't running in is "unknown".
async function pageApplyFlow(tabId) {
  if (!tabId) return "unknown";
  const frames = await bootstrappedFrames(tabId).catch(() => []);
  const flows = await Promise.all(
    frames.map((frameId) =>
      chrome.tabs.sendMessage(tabId, { type: "GET_APPLY_FLOW" }, { frameId }).then((r) => r?.flow, () => null)
    )
  );
  if (flows.includes("multi")) return "multi";
  return flows.includes("single") ? "single" : "unknown";
}

// "GRID eSports GmbH · Backend Engineer" from companyName "GRID_eSports_GmbH" and title
// "GRID eSports GmbH - Backend Engineer": underscores become spaces and the company is not repeated in the title.
function jobLine(companyName, rawTitle) {
  const company = String(companyName || "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  let title = String(rawTitle || "").trim();
  if (company) {
    const name = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s_]+");
    const shorter = title
      .replace(new RegExp(`^${name}\\s*[-–—|:·@]\\s*`, "i"), "")
      .replace(new RegExp(`\\s*(?:[-–—|:·@]|\\bat\\b)\\s*${name}$`, "i"), "")
      .trim();
    title = shorter.toLowerCase() === company.toLowerCase() ? "" : shorter || title;
  }
  return [company, title].filter(Boolean).join(" · ");
}

async function uploadScreenshot() {
  const button = $("upload");
  button.disabled = true;
  button.textContent = "Capturing & uploading…";
  setText("result", "");
  // The background does the capture, the same way as for the keyboard shortcut.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const result = await chrome.runtime
    .sendMessage({ type: "CAPTURE_TAB", payload: { tabId: tab?.id } })
    .catch((err) => ({ ok: false, feedback: { tone: "error", text: err.message || "Could not capture this page" } }));
  const feedback = result?.feedback || { tone: "error", text: result?.error || "Could not capture this page" };
  setText("result", feedback.text, feedback.tone);
  button.disabled = false;
  await showNextStep();
  // An upload refused with 401 logs the extension out; show the login form and its notice.
  if (!(await getAuth())) await render();
}

// Frames where the page script is running (it marks them).
async function bootstrappedFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => !!window.__bidTrackBootstrapped
  });
  return results.filter((r) => r.result).map((r) => r.frameId);
}

async function showShortcut() {
  // chrome.commands only exists once Chrome has loaded a manifest that declares the shortcut: an unpacked extension
  // whose files changed keeps its old manifest until Reload on chrome://extensions.
  if (!chrome.commands) {
    $("shortcut").textContent = "Reload Bid Track to turn it on";
    return;
  }
  const commands = await chrome.commands.getAll().catch(() => []);
  // Empty when Chrome dropped the default because another extension already uses the key.
  $("shortcut").textContent = commands.find((c) => c.name === "capture")?.shortcut || "Not set";
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const current = $("current-password").value;
  const next = $("new-password").value;
  if (next !== $("confirm-password").value) {
    setText("password-result", "The new passwords don't match", "error");
    return;
  }
  const button = $("password-submit");
  button.disabled = true;
  setText("password-result", "");
  try {
    await changePassword(current, next);
    event.target.reset();
    setText("password-result", "Password changed. Other browsers using this login were logged out.", "ok");
  } catch (err) {
    setText("password-result", err instanceof ApiError ? err.message : "Something went wrong — try again", "error");
  } finally {
    button.disabled = false;
  }
  if (!(await getAuth())) await render();
}

async function saveAutoDownload() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, autoSaveScreenshots: $("auto-download").checked } });
}

function setText(id, text, tone = "") {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  if (el.classList.contains("result")) el.dataset.tone = tone;
}
