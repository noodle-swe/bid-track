import { getAuth, register, login, logout, me, ApiError } from "../lib/api.js";

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
  await render();
});

async function render() {
  let auth = await getAuth();
  if (auth) {
    // A 401 here clears auth and sets the notice; offline or server errors keep the cached login.
    await me().catch(() => null);
    auth = await getAuth();
  }
  const loggedIn = !!auth?.bidder;
  $("auth").classList.toggle("hidden", loggedIn);
  $("main").classList.toggle("hidden", !loggedIn);
  $("account").classList.toggle("hidden", !loggedIn);

  if (loggedIn) {
    $("username").textContent = auth.bidder.username || auth.bidder.name || "";
    const { settings = {} } = await chrome.storage.local.get("settings");
    $("auto-download").checked = settings.autoSaveScreenshots !== false;
    setText("result", "");
    return;
  }
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

async function uploadScreenshot() {
  const button = $("upload");
  button.disabled = true;
  setText("result", "Saving…", "busy");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open a job page first");
    const frameId = await findCaptureFrame(tab.id);
    showCaptureResult(await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_NOW" }, { frameId }));
  } catch (err) {
    setText("result", friendlyError(err), "error");
  } finally {
    button.disabled = false;
  }
  // An upload refused with 401 logs the extension out; show the login form and its notice.
  if (!(await getAuth())) await render();
}

// Frames where the page script is running (it marks them); the top frame is preferred so one
// click captures once.
async function bootstrappedFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => !!window.__bidTrackBootstrapped
  });
  return results.filter((r) => r.result).map((r) => r.frameId);
}

async function findCaptureFrame(tabId) {
  let frames = await bootstrappedFrames(tabId);
  if (!frames.length) {
    // Tab opened before the extension was loaded: inject the page script as the manifest would.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/content.js"] });
    frames = await bootstrappedFrames(tabId);
  }
  if (!frames.length) throw new Error("No job detected on this page");
  return frames.includes(0) ? 0 : frames[0];
}

function showCaptureResult(result) {
  if (!result?.ok) {
    setText("result", result?.error || "Could not capture this page", "error");
  } else if (result.upload.ok) {
    setText("result", `✓ Step ${result.step} saved · uploaded`, "ok");
  } else if (result.upload.error === "not logged in") {
    setText("result", `Step ${result.step} saved — log in so this bid counts`, "error");
  } else {
    setText("result", `Step ${result.step} saved — upload failed (${result.upload.error}). Try again.`, "error");
  }
}

function friendlyError(err) {
  const message = err?.message || "";
  if (/cannot access|cannot be scripted|extensions gallery/i.test(message)) return "Bid Track can't capture this page";
  if (/receiving end does not exist/i.test(message)) return "No job detected on this page";
  return message || "Could not capture this page";
}

async function saveAutoDownload() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, autoSaveScreenshots: $("auto-download").checked } });
}

function setText(id, text, tone = "") {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  if (id === "result") el.dataset.tone = tone;
}
