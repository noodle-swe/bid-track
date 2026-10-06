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
  autoSaveScreenshots: true,
  screenshotFolder: "BidTrackScreenshots"
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
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function getRecords() {
  const { records } = await chrome.storage.local.get("records");
  return (records || []).map(normalizeRecord);
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

// Step numbers count one bidder's screenshots of a job on one day: the bidder's local date, as in the upload's date
// folder. Another bidder logging in on this browser, or a new day, starts again at step 1.
export function stepOwnerKey(bidder, date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${bidder?.username || bidder?.id || ""}|${day}`;
}

// Records saved before 3.2.0 have no stepCounts and keep their count, so nobody restarts mid-application on update.
export function stepsTaken(record, owner) {
  if (!record) return 0;
  if (!record.stepCounts) return record.stepCount || 0;
  return record.stepCounts[owner] || 0;
}

// The record's per-owner counts after `owner` took `step`; other days' counts are dropped.
export function withStepTaken(record, owner, step) {
  const today = owner.slice(owner.lastIndexOf("|"));
  const kept = Object.entries(record.stepCounts || {}).filter(([key]) => key.endsWith(today));
  return { ...Object.fromEntries(kept), [owner]: step };
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
