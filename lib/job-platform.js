import { sanitizeFolderName } from "./sanitize.js";

const LOCALE_PATTERN = /^[a-z]{2}(?:-[a-z]{2})?$/i;

const WORKDAY_REQUISITION_PATTERN = /_?([Rr])(-?)(\d+)/i;

export const APPLY_STEP_SEGMENTS = new Set([
  "apply",
  "application",
  "applications",
  "applymanually",
  "applyuseprevious",
  "usemylastapplication",
  "autofillwithresume",
  "login",
  "signin",
  "signup",
  "createaccount",
  "register",
  "task",
  "tasks",
  "questions",
  "questionnaire",
  "survey",
  "review",
  "confirmation",
  "confirmed",
  "submitted",
  "success",
  "thankyou",
  "thank-you",
  "error",
  "introduceyourself",
  "resume",
  "coverletter",
  "experience",
  "education",
  "skills",
  "disability",
  "selfidentification",
  "voluntary",
  "mycinformation",
  "jobapplication",
  "candidate",
  "profile",
  "personalinfo",
  "personal-information",
  "eeo",
  "consent",
  "privacy",
  "documents",
  "attachments",
  "submit"
]);

const GENERIC_PATH_SKIP = new Set([
  "jobs",
  "job",
  "careers",
  "career",
  "apply",
  "application",
  "postings",
  "posting",
  "opportunities",
  "opportunity",
  "openings",
  "opening",
  "positions",
  "position",
  "login",
  "task",
  "review",
  "search",
  "results",
  "board",
  "boards",
  "en",
  "us"
]);

const ATS_HOST_RULES = [
  { platform: "workday", pattern: /myworkdayjobs\.com/i },
  { platform: "icims", pattern: /icims\.com/i },
  { platform: "greenhouse", pattern: /greenhouse\.io/i },
  { platform: "lever", pattern: /lever\.co/i },
  { platform: "ashby", pattern: /ashbyhq\.com/i },
  { platform: "smartrecruiters", pattern: /smartrecruiters\.com/i },
  { platform: "jobvite", pattern: /jobvite\.com/i },
  { platform: "breezy", pattern: /breezy\.hr/i },
  { platform: "recruitee", pattern: /recruitee\.com/i },
  { platform: "taleo", pattern: /taleo\.net/i },
  { platform: "successfactors", pattern: /successfactors\.(com|eu)/i },
  { platform: "oracle", pattern: /oraclecloud\.com/i }
];

export function detectAtsPlatform(url) {
  try {
    const host = new URL(url).hostname;
    const rule = ATS_HOST_RULES.find((item) => item.pattern.test(host));
    return rule?.platform || "generic";
  } catch {
    return "generic";
  }
}

export function normalizeWorkdayRequisitionId(value = "") {
  const match = String(value || "").match(WORKDAY_REQUISITION_PATTERN);
  if (!match) return "";
  return sanitizeFolderName(`R-${match[3]}`);
}

export function extractRequisitionId(text = "") {
  return normalizeWorkdayRequisitionId(text);
}

export function normalizeJobId(value = "") {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";

  const workday = normalizeWorkdayRequisitionId(cleaned);
  if (workday) return workday;

  const numeric = cleaned.match(/\b(\d{4,})\b/);
  if (numeric) return sanitizeFolderName(numeric[1]);

  return sanitizeFolderName(cleaned);
}

function isApplyStepSegment(segment = "") {
  const lower = String(segment || "").toLowerCase();
  return APPLY_STEP_SEGMENTS.has(lower);
}

function pathParts(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function parseWorkdayIdentity(url, hints = {}) {
  try {
    const parsed = new URL(url);
    const hostMatch = parsed.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
    const tenantFromHost = hostMatch ? sanitizeFolderName(hostMatch[1]) : "";
    const parts = parsed.pathname.split("/").filter(Boolean);

    let siteIndex = 0;
    if (parts[0] && LOCALE_PATTERN.test(parts[0])) siteIndex = 1;

    const siteCandidate = parts[siteIndex];
    const site =
      siteCandidate &&
      siteCandidate.toLowerCase() !== "job" &&
      !isApplyStepSegment(siteCandidate)
        ? sanitizeFolderName(siteCandidate)
        : "";
    const company = tenantFromHost || site || sanitizeFolderName(parsed.hostname.split(".")[0]);

    let jobId =
      normalizeWorkdayRequisitionId(hints.jobId || hints.requisitionId || "") ||
      normalizeWorkdayRequisitionId(parsed.pathname + parsed.search + parsed.hash);

    const jobIdx = parts.findIndex((part) => part.toLowerCase() === "job");
    if (!jobId && jobIdx >= 0) {
      for (let i = parts.length - 1; i > jobIdx; i -= 1) {
        const part = parts[i];
        const reqFromPart = normalizeWorkdayRequisitionId(part);
        if (reqFromPart) {
          jobId = reqFromPart;
          break;
        }
        if (!part || isApplyStepSegment(part) || LOCALE_PATTERN.test(part)) continue;
        jobId = sanitizeFolderName(part);
        break;
      }
    }

    if (!jobId) return null;

    return {
      platform: "workday",
      company,
      jobId,
      hostname: parsed.hostname,
      stableKey: `workday:${parsed.hostname}|${company}|${jobId}`.toLowerCase()
    };
  } catch {
    return null;
  }
}

function parseGreenhouseIdentity(url, hints = {}) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const ghJid = parsed.searchParams.get("gh_jid") || parsed.searchParams.get("job_id");
    let company = "";
    let jobId = normalizeJobId(hints.jobId || hints.requisitionId || ghJid || "");

    const jobsIdx = parts.findIndex((part) => part.toLowerCase() === "jobs");
    if (jobsIdx > 0) company = sanitizeFolderName(parts[jobsIdx - 1]);
    if (!company && parts[0] && !LOCALE_PATTERN.test(parts[0])) company = sanitizeFolderName(parts[0]);

    if (!jobId && jobsIdx >= 0) {
      for (let i = parts.length - 1; i > jobsIdx; i -= 1) {
        const part = parts[i];
        if (/^\d+$/.test(part)) {
          jobId = sanitizeFolderName(part);
          break;
        }
      }
    }

    if (!company) company = sanitizeFolderName(parsed.hostname.split(".")[0]);
    if (!jobId) return null;

    return {
      platform: "greenhouse",
      company,
      jobId,
      hostname: parsed.hostname,
      stableKey: `greenhouse:${company}|${jobId}`.toLowerCase()
    };
  } catch {
    return null;
  }
}

function parseIcimsIdentity(url, hints = {}) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    let company = sanitizeFolderName(parsed.hostname.split(".")[0].replace(/^careers[-_]?/i, ""));
    let jobId = normalizeJobId(hints.jobId || hints.requisitionId || "");

    const jobsIdx = parts.findIndex((part) => part.toLowerCase() === "jobs");
    if (jobsIdx >= 0) {
      const idPart = parts[jobsIdx + 1];
      if (idPart && /^\d+$/.test(idPart)) jobId = sanitizeFolderName(idPart);
      if (!jobId) {
        for (let i = parts.length - 1; i > jobsIdx; i -= 1) {
          const part = parts[i];
          if (/^\d+$/.test(part)) {
            jobId = sanitizeFolderName(part);
            break;
          }
          if (!isApplyStepSegment(part) && !LOCALE_PATTERN.test(part)) {
            jobId = sanitizeFolderName(part);
            break;
          }
        }
      }
    }

    if (!jobId) jobId = normalizeJobId(parsed.pathname);
    if (!jobId) return null;

    return {
      platform: "icims",
      company,
      jobId,
      hostname: parsed.hostname,
      stableKey: `icims:${parsed.hostname}|${company}|${jobId}`.toLowerCase()
    };
  } catch {
    return null;
  }
}

function parseLeverIdentity(url, hints = {}) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const company = parts[0] ? sanitizeFolderName(parts[0]) : sanitizeFolderName(parsed.hostname.split(".")[0]);
    let jobId = normalizeJobId(hints.jobId || hints.requisitionId || "");

    if (!jobId) {
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        if (!part || isApplyStepSegment(part) || GENERIC_PATH_SKIP.has(part.toLowerCase())) continue;
        if (part === company) continue;
        jobId = sanitizeFolderName(part);
        break;
      }
    }

    if (!jobId) return null;

    return {
      platform: "lever",
      company,
      jobId,
      hostname: parsed.hostname,
      stableKey: `lever:${company}|${jobId}`.toLowerCase()
    };
  } catch {
    return null;
  }
}

function parseGenericIdentity(url, hints = {}) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const company = sanitizeFolderName(parsed.hostname.replace(/^www\./, "").split(".")[0]);
    let jobId = normalizeJobId(hints.jobId || hints.requisitionId || "");

    if (!jobId) {
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        const lower = part.toLowerCase();
        if (!part || GENERIC_PATH_SKIP.has(lower) || isApplyStepSegment(part)) continue;
        if (LOCALE_PATTERN.test(part)) continue;
        if (/^\d+$/.test(part)) {
          jobId = sanitizeFolderName(part);
          break;
        }
        const req = normalizeWorkdayRequisitionId(part);
        if (req) {
          jobId = req;
          break;
        }
        jobId = sanitizeFolderName(part);
        break;
      }
    }

    if (!jobId) return null;

    return {
      platform: detectAtsPlatform(url),
      company,
      jobId,
      hostname: parsed.hostname,
      stableKey: `generic:${parsed.hostname}|${company}|${jobId}`.toLowerCase()
    };
  } catch {
    return null;
  }
}

export function parseJobIdentity(url, hints = {}) {
  const platform = detectAtsPlatform(url);
  let identity = null;

  if (platform === "workday") identity = parseWorkdayIdentity(url, hints);
  else if (platform === "greenhouse") identity = parseGreenhouseIdentity(url, hints);
  else if (platform === "icims") identity = parseIcimsIdentity(url, hints);
  else if (platform === "lever") identity = parseLeverIdentity(url, hints);
  else identity = parseGenericIdentity(url, hints);

  if (identity) return identity;
  return parseGenericIdentity(url, hints);
}

export function getJobSessionKeyFromIdentity(url, hints = {}) {
  const identity = parseJobIdentity(url, hints);
  return identity?.stableKey || "";
}

export function isSameAtsApplication(urlA, urlB, context = {}) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    const platformA = detectAtsPlatform(urlA);
    const platformB = detectAtsPlatform(urlB);
    if (platformA !== platformB) return false;

    const idA = parseJobIdentity(urlA, {
      jobId: context.jobId || context.requisitionId || "",
      requisitionId: context.requisitionId || context.jobId || ""
    });
    const idB = parseJobIdentity(urlB, context);
    if (idA?.stableKey && idB?.stableKey && idA.stableKey === idB.stableKey) return true;

    if (platformA === "workday" && a.hostname === b.hostname) return true;

    if (
      context.allowSameCompanyFlow &&
      idA?.company &&
      idB?.company &&
      idA.company === idB.company &&
      (context.existingJobId || idA?.jobId) &&
      (!idB?.jobId || idA?.jobId === idB?.jobId)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function hasStableJobIdentity(url, hints = {}) {
  const identity = parseJobIdentity(url, hints);
  if (!identity?.company || !identity?.jobId) return false;
  return !isApplyStepSegment(identity.jobId);
}

export function buildJobFolderName(record, hints = {}) {
  const identity = parseJobIdentity(record.url, {
    jobId: hints.jobId || record.jobId || record.workdayRequisitionId || record.requisitionId || "",
    requisitionId: hints.requisitionId || record.workdayRequisitionId || record.requisitionId || ""
  });

  if (identity?.company && identity?.jobId) {
    return sanitizeFolderName(`${identity.company}_${identity.jobId}`);
  }

  return sanitizeFolderName(identity?.company || "job");
}

export function isWeakJobFolder(folder = "") {
  const name = String(folder).split("/").pop().toLowerCase();
  if (!name) return true;
  if (/^(en-us|en-gb|es-es|fr-fr|de-de|pt-br|ja-jp)_/.test(name)) return true;

  for (const step of APPLY_STEP_SEGMENTS) {
    if (name === step || name.endsWith(`_${step}`) || name.startsWith(`${step}_`)) return true;
  }

  return false;
}

export function isStrongJobFolder(folder = "") {
  const name = String(folder).split("/").pop() || "";
  if (/R-\d+/i.test(name)) return true;
  if (/_\d{4,}$/.test(name)) return true;
  if (/-\d{4,}$/.test(name)) return true;
  return false;
}

export function getCompanyFromIdentity(url, title = "") {
  const identity = parseJobIdentity(url);
  if (identity?.company) return identity.company;

  const text = String(title || "").replace(/\s+/g, " ").trim();
  const atMatch = text.match(/^(.+?)\s+at\s+(.+?)$/i);
  if (atMatch?.[2]) return sanitizeFolderName(atMatch[2]);

  try {
    return sanitizeFolderName(new URL(url).hostname.replace(/^www\./, "").split(".")[0]);
  } catch {
    return "unknown";
  }
}
