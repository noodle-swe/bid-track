export const DEFAULT_SERVER_URL = "https://engineersbackend-production.up.railway.app";

const RESET_NOTICE = "Your login was reset — ask your manager for a new invite code.";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return normalizeServerUrl(serverUrl);
}

export async function setServerUrl(url) {
  await chrome.storage.local.set({ serverUrl: normalizeServerUrl(url) });
}

function normalizeServerUrl(url) {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_SERVER_URL;
}

export async function getAuth() {
  const { authToken, authBidder } = await chrome.storage.local.get(["authToken", "authBidder"]);
  if (!authToken) return null;
  return { token: authToken, bidder: authBidder || null };
}

async function storeAuth(token, bidder) {
  await chrome.storage.local.set({ authToken: token, authBidder: bidder });
  await chrome.storage.local.remove("authNotice");
}

export async function register(inviteCode, username, password) {
  const { token, bidder } = await request("POST", "/ext/register", { inviteCode, username, password });
  await storeAuth(token, bidder);
  return bidder;
}

export async function login(username, password) {
  const { token, bidder } = await request("POST", "/ext/login", { username, password });
  await storeAuth(token, bidder);
  return bidder;
}

export async function logout() {
  await chrome.storage.local.remove(["authToken", "authBidder"]);
}

export async function me() {
  const bidder = await authedRequest("GET", "/ext/me");
  await chrome.storage.local.set({ authBidder: bidder });
  return bidder;
}

export async function getUploadUrl({ job, step, trigger, capturedAt }) {
  return authedRequest("POST", "/ext/upload-url", { job, step, trigger, capturedAt });
}

// 2026-10-03T11:29:07-03:00 (local time with its UTC offset, as the backend requires).
export function localIsoWithOffset(date) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
  );
}

async function authedRequest(method, path, body) {
  const auth = await getAuth();
  if (!auth) throw new ApiError("not logged in", 401);
  try {
    return await request(method, path, body, auth.token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await chrome.storage.local.remove(["authToken", "authBidder"]);
      await chrome.storage.local.set({ authNotice: RESET_NOTICE });
    }
    throw err;
  }
}

async function request(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${await getServerUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new ApiError(`Could not reach the server (${err.message})`, 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(errorMessage(data, response.status), response.status);
  return data;
}

function errorMessage(data, status) {
  const detail = data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && typeof detail[0]?.msg === "string") return detail[0].msg;
  return `HTTP ${status}`;
}
