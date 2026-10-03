import {
  buildJobFolderName,
  detectAtsPlatform,
  getCompanyFromIdentity,
  getJobSessionKeyFromIdentity,
  hasStableJobIdentity as hasStableIdentity,
  isSameAtsApplication,
  isStrongJobFolder,
  isWeakJobFolder,
  normalizeJobId,
  normalizeWorkdayRequisitionId,
  parseJobIdentity
} from "./job-platform.js";
import { normalizeApplicationKey, normalizeKeyId, validateBackblazeCredentials } from "./b2-credentials.js";
import { safeHost, sanitizeFolderName } from "./sanitize.js";

export {
  detectAtsPlatform,
  isSameAtsApplication,
  isStrongJobFolder,
  isWeakJobFolder,
  normalizeJobId,
  normalizeWorkdayRequisitionId,
  parseJobIdentity
} from "./job-platform.js";
export { safeHost, sanitizeFolderName } from "./sanitize.js";

export const EXCLUDED_HOSTS = [
  "linkedin.com",
  "www.linkedin.com",
  "indeed.com",
  "www.indeed.com"
];

export const DEFAULT_SETTINGS = {
  showCaptureButton: true,
  autoCapture: false,
  autoSaveScreenshots: true,
  autoSaveJson: true,
  screenshotFolder: "BidTrackScreenshots",
  b2Enabled: true,
  b2BucketName: "bid-screenshots",
  b2BucketId: "0f6e97821fb60a18ab150c15",
  b2KeyId: "005fe72f6a8b5c50000000001",
  b2ApplicationKey: "",
  b2KeyPrefix: "puma",
  b2ProfileName: "upwork",
  b2UploadApi: "s3",
  b2S3Region: "us-east-005",
  b2S3Endpoint: "https://s3.us-east-005.backblazeb2.com"
};

export function isExcludedUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return EXCLUDED_HOSTS.some(
      (h) => host === h.replace(/^www\./, "") || host.endsWith("." + h.replace(/^www\./, ""))
    );
  } catch {
    return false;
  }
}

export function looksLikeJobPage(url, title, description) {
  if (isExcludedUrl(url)) return false;
  const text = `${url} ${title} ${description}`.toLowerCase();
  const keywords = [
    "apply",
    "application",
    "job",
    "career",
    "position",
    "opening",
    "candidate",
    "resume",
    "empleo",
    "trabajo",
    "puesto",
    "candidato",
    "solicitud",
    "curriculum",
    "currículum",
    "vacante",
    "keyrus",
    "greenhouse",
    "lever",
    "workday",
    "ashby",
    "bamboohr",
    "jobvite",
    "smartrecruiters",
    "breezy",
    "recruitee",
    "icims"
  ];
  return keywords.some((k) => text.includes(k));
}

export async function getSettings() {
  const { settings, b2ApplicationKeySecret } = await chrome.storage.local.get([
    "settings",
    "b2ApplicationKeySecret"
  ]);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (!String(merged.b2BucketName || "").trim()) merged.b2BucketName = DEFAULT_SETTINGS.b2BucketName;
  if (!String(merged.b2BucketId || "").trim()) merged.b2BucketId = DEFAULT_SETTINGS.b2BucketId;
  if (!String(merged.b2KeyId || "").trim()) merged.b2KeyId = DEFAULT_SETTINGS.b2KeyId;
  if (!String(merged.b2KeyPrefix || "").trim()) merged.b2KeyPrefix = DEFAULT_SETTINGS.b2KeyPrefix;
  if (!String(merged.b2ProfileName || "").trim()) merged.b2ProfileName = DEFAULT_SETTINGS.b2ProfileName;
  if (!String(merged.b2UploadApi || "").trim()) merged.b2UploadApi = DEFAULT_SETTINGS.b2UploadApi;
  if (!String(merged.b2S3Region || "").trim()) merged.b2S3Region = DEFAULT_SETTINGS.b2S3Region;
  if (!String(merged.b2S3Endpoint || "").trim()) merged.b2S3Endpoint = DEFAULT_SETTINGS.b2S3Endpoint;
  merged.b2KeyId = normalizeKeyId(merged.b2KeyId);
  merged.b2ApplicationKey = normalizeApplicationKey(b2ApplicationKeySecret);
  delete merged.b2ApplicationKeyLegacy;
  return merged;
}

export async function getBackblazeKeySaved() {
  const settings = await getSettings();
  return validateBackblazeCredentials(settings).ok;
}

export { validateBackblazeCredentials } from "./b2-credentials.js";

export async function saveBackblazeApplicationKey(applicationKey) {
  const trimmed = String(applicationKey || "").trim();
  if (!trimmed) return false;
  await chrome.storage.local.set({ b2ApplicationKeySecret: trimmed });
  return true;
}

export async function getRecords() {
  const { records } = await chrome.storage.local.get("records");
  return (records || []).map(normalizeRecord);
}

export async function getScreenshot(recordId, captureId) {
  const { screenshots = {} } = await chrome.storage.local.get("screenshots");
  return screenshots?.[recordId]?.[captureId] || null;
}

export async function getRecordScreenshots(recordId) {
  const { screenshots = {} } = await chrome.storage.local.get("screenshots");
  return screenshots?.[recordId] || {};
}

export async function saveScreenshot(recordId, captureId, dataUrl) {
  const { screenshots = {} } = await chrome.storage.local.get("screenshots");
  if (!screenshots[recordId]) screenshots[recordId] = {};
  screenshots[recordId][captureId] = dataUrl;
  await chrome.storage.local.set({ screenshots });
}

export async function deleteRecordScreenshots(recordId) {
  const { screenshots = {} } = await chrome.storage.local.get("screenshots");
  delete screenshots[recordId];
  await chrome.storage.local.set({ screenshots });
}

function normalizeRecord(record) {
  return {
    ...record,
    captures: Array.isArray(record.captures) ? record.captures : [],
    jobDescription: record.jobDescription || "",
    stepCount: record.stepCount || 0,
    jobSessionKey: record.jobSessionKey || getJobSessionKey(record.url, record.title, getRecordHints(record)),
    companyName: record.companyName || getCompanyLabel(record.url, record.title),
    downloadFolder:
      record.downloadFolder || buildJobDownloadFolder(record, DEFAULT_SETTINGS.screenshotFolder)
  };
}

function getRecordHints(record = {}) {
  return {
    jobId: record.jobId || record.workdayRequisitionId || record.requisitionId || "",
    requisitionId: record.workdayRequisitionId || record.requisitionId || record.jobId || ""
  };
}

export async function saveRecord(record) {
  const records = await getRecords();
  const storedRecord = normalizeRecord(record);
  const idx = records.findIndex((r) => r.id === storedRecord.id);
  if (idx >= 0) {
    records[idx] = storedRecord;
  } else {
    records.unshift(storedRecord);
  }
  await chrome.storage.local.set({ records });
  return storedRecord;
}

export async function getActiveRecordId(tabId) {
  const key = `activeRecord_${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

export async function setActiveRecordId(tabId, recordId) {
  const key = `activeRecord_${tabId}`;
  await chrome.storage.session.set({ [key]: recordId });
}

export async function clearActiveRecordId(tabId) {
  const key = `activeRecord_${tabId}`;
  await chrome.storage.session.remove(key);
}

const INVALID_JOB_DESCRIPTION_PATTERNS = [
  /equal employment opportunity/i,
  /does not discriminate against any applicant/i,
  /©\s*\d{4}/i,
  /all rights reserved/i,
  /privacy policy|terms of use|cookie policy/i,
  /vista global holding limited/i,
  /office \d+.*(?:dubai|uae|finance centre|finance center)/i
];

const EXPIRED_JOB_PAGE_PATTERNS = [
  /requested job could not be found/i,
  /does not exist or is no longer open/i,
  /this (?:job|position|posting) (?:is )?(?:no longer|not) (?:available|open)/i,
  /position (?:has been|is) filled/i,
  /job (?:has )?expired/i,
  /posting (?:has )?closed/i,
  /no longer accepting applications/i,
  /search results page \d+ of/i
];

const INVALID_JOB_TITLE_PATTERNS = [
  /^about\s[-|]/i,
  /^error:/i,
  /search results page/i,
  /^welcome page$/i,
  /^careers?$/i
];

export function isExpiredJobPage(title = "", description = "", pageText = "") {
  const text = `${title} ${description} ${pageText}`.replace(/\s+/g, " ").trim();
  return EXPIRED_JOB_PAGE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isBoilerplateJobDescription(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return true;

  const matched = INVALID_JOB_DESCRIPTION_PATTERNS.filter((pattern) => pattern.test(cleaned)).length;
  if (matched >= 2) return true;

  if (/equal employment opportunity employer/i.test(cleaned) && cleaned.length < 900) return true;

  if (
    /©\s*\d{4}/.test(cleaned) &&
    !/(responsibilities|requirements|qualifications|experience|skills|what you|about the role|job summary)/i.test(
      cleaned
    )
  ) {
    return true;
  }

  return false;
}

export function hasValidJobTitle(title = "") {
  const cleaned = String(title || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 5) return false;
  return !INVALID_JOB_TITLE_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function hasValidJobDescription(text, options = {}) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 50) return false;
  if (isBoilerplateJobDescription(cleaned)) return false;
  if (isExpiredJobPage(options.title || "", cleaned, options.pageText || "")) return false;
  return true;
}

export function isTrackableJobPage(payload = {}) {
  const { title = "", jobDescription = "", pageText = "", pageError = false } = payload;
  const expired = pageError || isExpiredJobPage(title, jobDescription, pageText);

  if (expired) return false;
  if (!hasValidJobTitle(title)) return false;
  if (!hasValidJobDescription(jobDescription, { title, pageText })) return false;
  return true;
}

export function enrichJobPagePayload(payload = {}) {
  const title = payload.title || "";
  const jobDescription = payload.jobDescription || "";
  const pageText = payload.pageText || "";
  return {
    ...payload,
    pageError: !!(payload.pageError || isExpiredJobPage(title, jobDescription, pageText))
  };
}

export function createRecordId() {
  return `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isWorkdayJobsUrl(url) {
  return detectAtsPlatform(url) === "workday";
}

export function extractWorkdayRequisitionId(text = "") {
  return normalizeWorkdayRequisitionId(text);
}

export function getWorkdayRequisitionId(url, hints = {}) {
  const merged = {
    jobId: hints.jobId || hints.requisitionId || "",
    requisitionId: hints.requisitionId || hints.jobId || ""
  };
  const identity = parseJobIdentity(url, merged);
  if (identity?.platform === "workday" && /R-\d+/i.test(identity.jobId)) return identity.jobId;
  return normalizeWorkdayRequisitionId(merged.requisitionId || merged.jobId || url);
}

export function isSameWorkdayTenant(urlA, urlB, context = {}) {
  return isSameAtsApplication(urlA, urlB, context);
}

export function getJobSessionKey(url, title = "", hints = {}) {
  const fromIdentity = getJobSessionKeyFromIdentity(url, hints);
  if (fromIdentity) return fromIdentity;

  try {
    const parsed = new URL(url);
    return `generic:${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

export function hasStableJobIdentity(url, title = "", hints = {}) {
  return hasStableIdentity(url, hints);
}

export function isStrongWorkdayFolder(folder = "") {
  return isStrongJobFolder(folder);
}

export function isWeakDownloadFolder(folder = "") {
  return isWeakJobFolder(folder);
}

export function getCompanyNameFromUrl(url) {
  return getCompanyFromIdentity(url);
}

export function extractCompanyFromTitle(title, urlHint = "") {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  const urlCompany = getCompanyNameFromUrl(urlHint).toLowerCase();
  const segments = text.split(/\s[-|@]\s/).map((part) => part.trim()).filter(Boolean);

  if (segments.length >= 2) {
    const normalized = segments.map((part) => ({
      raw: part,
      slug: sanitizeFolderName(part).toLowerCase()
    }));

    const urlMatch = normalized.find(
      (part) =>
        urlCompany &&
        urlCompany !== "unknown" &&
        (part.slug.includes(urlCompany) || urlCompany.includes(part.slug))
    );
    if (urlMatch) return sanitizeFolderName(urlMatch.raw);

    const careersMatch = normalized.find((part) => /careers?/i.test(part.raw));
    if (careersMatch) return sanitizeFolderName(careersMatch.raw.replace(/\s+careers?$/i, ""));

    return sanitizeFolderName(segments[segments.length - 1]);
  }

  const atMatch = text.match(/^(.+?)\s+at\s+(.+?)$/i);
  if (atMatch?.[2]) return sanitizeFolderName(atMatch[2]);

  return "";
}

export function getCompanyLabel(url, title = "") {
  const fromUrl = getCompanyNameFromUrl(url);
  const fromTitle = extractCompanyFromTitle(title, url);

  if (fromTitle) return fromTitle;
  if (fromUrl && fromUrl !== "unknown") return fromUrl;

  const identity = parseJobIdentity(url);
  if (identity?.jobId) return sanitizeFolderName(identity.jobId);
  return sanitizeFolderName(safeHost(url));
}

export function getJobSlugFromUrl(url, hints = {}) {
  const identity = parseJobIdentity(url, hints);
  return identity?.jobId || sanitizeFolderName(safeHost(url));
}

export function buildJobDownloadFolder(record, rootFolder = "BidTrackScreenshots") {
  const root = sanitizeFolderName(rootFolder || "BidTrackScreenshots");
  const hints = getRecordHints(record);
  const folderName = buildJobFolderName(record, hints);
  return `${root}/${sanitizeFolderName(folderName)}`;
}

export function buildRecordExport(record) {
  return {
    id: record.id,
    url: record.url,
    title: record.title || "",
    companyName: record.companyName || getCompanyLabel(record.url, record.title),
    jobSessionKey: record.jobSessionKey || getJobSessionKey(record.url, record.title, getRecordHints(record)),
    jobId: record.jobId || record.workdayRequisitionId || record.requisitionId || "",
    atsPlatform: record.atsPlatform || detectAtsPlatform(record.url),
    downloadFolder: record.downloadFolder || "",
    jobDescription: record.jobDescription || "",
    status: record.status || "",
    stepCount: record.stepCount || 0,
    captures: (record.captures || []).map((capture) => ({
      step: capture.step,
      trigger: capture.trigger,
      pageUrl: capture.pageUrl || "",
      screenshotFileName: capture.screenshotFileName || "",
      capturedAt: capture.capturedAt || ""
    })),
    jsonFileName: record.jsonFileName || "",
    jsonExportedAt: record.jsonExportedAt || "",
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || "",
    submittedAt: record.submittedAt || "",
    exportedAt: new Date().toISOString()
  };
}
