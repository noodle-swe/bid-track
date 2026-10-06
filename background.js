import {
  buildJobDownloadFolder,
  buildRecordExport,
  clearActiveRecordId,
  createRecordId,
  deleteRecordScreenshots,
  getActiveRecordId,
  getCompanyLabel,
  getJobSessionKey,
  getRecords,
  getRecordScreenshots,
  getScreenshot,
  getSettings,
  detectAtsPlatform,
  getWorkdayRequisitionId,
  hasStableJobIdentity,
  hasValidJobDescription,
  hasValidJobTitle,
  isExpiredJobPage,
  isTrackableJobPage,
  enrichJobPagePayload,
  isExcludedUrl,
  isSameWorkdayTenant,
  isWeakDownloadFolder,
  looksLikeJobPage,
  normalizeJobId,
  parseJobIdentity,
  saveRecord,
  saveScreenshot,
  setActiveRecordId
} from "./lib/storage.js";
import { getArtifactBackend } from "./lib/artifact-storage.js";
import { confirmUpload, getAuth, getUploadUrl, localIsoWithOffset } from "./lib/api.js";

const captureQueue = new Map();

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("Bid Track installed");
  if (details.reason === "update") await removeLegacyBackblazeSettings();
});

// Versions before 3.0 stored Backblaze keys locally; uploads now go through signed links.
async function removeLegacyBackblazeSettings() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && typeof settings === "object") {
      const cleaned = Object.fromEntries(Object.entries(settings).filter(([key]) => !key.startsWith("b2")));
      await chrome.storage.local.set({ settings: cleaned });
    }
    await chrome.storage.local.remove("b2ApplicationKeySecret");
  } catch (err) {
    console.warn("[Bid Track] Could not remove legacy Backblaze settings:", err.message);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case "INIT_JOB_RECORD":
      return initJobRecord(message.payload, tabId);

    case "UPDATE_JOB_META":
      return updateJobMeta(message.payload, tabId);

    case "CAPTURE_PAGE":
      return capturePage(message.payload, tabId);

    case "GET_ACTIVE_RECORD": {
      let targetTabId = tabId;
      if (!targetTabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = tab?.id;
      }
      return getActiveRecordForTab(targetTabId);
    }

    case "GET_RECORDS":
      return getRecordsWithScreenshots();

    case "DELETE_RECORD":
      return deleteRecord(message.payload.id);

    case "DOWNLOAD_SCREENSHOT":
      return downloadScreenshot(message.payload);

    case "DOWNLOAD_JSON":
      return downloadRecordJson(message.payload);

    case "PING":
      return { ok: true };

    default:
      return { ok: false, error: "Unknown message type" };
  }
}

async function initJobRecord(payload, tabId) {
  if (!tabId) return { ok: false, error: "No tab" };

  payload = enrichJobPagePayload(payload);
  const { url, title, jobDescription } = payload;
  if (isExcludedUrl(url)) {
    return { ok: false, excluded: true, reason: "LinkedIn and Indeed are excluded" };
  }

  const settings = await getSettings();
  const records = await getRecords();
  const sessionHints = getSessionHints(payload);
  const sessionKey = getJobSessionKey(url, title, sessionHints);
  const existing = await findExistingRecord(url, title, tabId, records, sessionKey, sessionHints);

  if (existing) {
    if (jobDescription && jobDescription.length > (existing.jobDescription || "").length) {
      existing.jobDescription = jobDescription;
    }
    if (title && (!existing.title || existing.title.length < title.length)) {
      existing.title = title;
    }
    existing.url = pickPreferredJobUrl(existing.url, url);
    existing.updatedAt = new Date().toISOString();
    applySessionHints(existing, payload, sessionHints, sessionKey);

    await setActiveRecordId(tabId, existing.id);

    const mergedTrackPayload = {
      ...payload,
      title: title || existing.title || "",
      jobDescription: jobDescription || existing.jobDescription || ""
    };

    if (!isTrackableJobPage(mergedTrackPayload) && !isTrackableJobPage(payload)) {
      const keepExisting =
        payload.hasApplicationForm ||
        existing.downloadFolderLocked ||
        (existing.stepCount || 0) > 0 ||
        (existing.captures || []).length > 0 ||
        (existing.jobDescription || "").length > 0;

      if (!keepExisting) {
        await purgeInvalidJobRecord(existing, tabId, payload);
        return { ok: false, skipped: true, reason: getSkipReason(payload) };
      }

      assignDownloadPaths(existing, settings);
      await saveRecord(existing);
      return { ok: true, record: existing, reused: true };
    }

    assignDownloadPaths(existing, settings);
    if (!existing.jsonExportedAt) {
      await ensureJobFolder(existing, settings);
    }

    await saveRecord(existing);
    return { ok: true, record: existing, reused: true };
  }

  if (!isTrackableJobPage(payload) && !payload.hasApplicationForm && !looksLikeJobPage(url, title, jobDescription)) {
    return { ok: false, skipped: true, reason: "Not detected as a job page" };
  }

  const allowApplyStepRecord =
    payload.hasApplicationForm && hasStableJobIdentity(url, title, sessionHints);

  if (!isTrackableJobPage(payload) && !allowApplyStepRecord) {
    const existingId = await getActiveRecordId(tabId);
    const staleMatches = records.filter(
      (record) =>
        (record.jobSessionKey === sessionKey || record.id === existingId) &&
        (record.stepCount || 0) === 0 &&
        !(record.captures || []).length
    );
    for (const stale of staleMatches) {
      await purgeInvalidJobRecord(stale, tabId, payload);
    }
    return { ok: false, skipped: true, reason: getSkipReason(payload) };
  }

  if (!hasStableJobIdentity(url, title, sessionHints)) {
    return { ok: false, skipped: true, reason: "No job identity" };
  }

  const record = {
    id: createRecordId(),
    url,
    title: title || "",
    jobDescription: jobDescription || "",
    companyName: getCompanyLabel(url, title),
    jobSessionKey: sessionKey,
    workdayRequisitionId: sessionHints.requisitionId || getWorkdayRequisitionId(url, sessionHints),
    jobId: normalizeJobId(sessionHints.jobId || sessionHints.requisitionId || getWorkdayRequisitionId(url, sessionHints)),
    requisitionId: normalizeJobId(sessionHints.jobId || sessionHints.requisitionId || getWorkdayRequisitionId(url, sessionHints)),
    atsPlatform: detectAtsPlatform(url),
    status: "in_progress",
    stepCount: 0,
    captures: [],
    jsonFileName: null,
    downloadFolder: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    submittedAt: null
  };

  assignDownloadPaths(record, settings);
  await saveRecord(record);
  await setActiveRecordId(tabId, record.id);
  if (isTrackableJobPage(payload)) {
    await ensureJobFolder(record, settings);
  }
  notifyRecordUpdated(record);
  return { ok: true, record, reused: false };
}

function pickPreferredJobUrl(currentUrl, nextUrl) {
  if (!currentUrl) return nextUrl;
  if (!nextUrl) return currentUrl;
  if (hasStableJobIdentity(nextUrl) && !hasStableJobIdentity(currentUrl)) return nextUrl;
  if (WORKDAY_REQUISITION_PATTERN.test(nextUrl) && !WORKDAY_REQUISITION_PATTERN.test(currentUrl)) return nextUrl;
  return currentUrl;
}

const WORKDAY_REQUISITION_PATTERN = /_?([Rr])(-?)(\d+)/i;

function getSessionHints(payload = {}) {
  const jobId = payload.jobId || payload.workdayRequisitionId || payload.requisitionId || "";
  return {
    jobId,
    requisitionId: payload.workdayRequisitionId || payload.requisitionId || jobId
  };
}

function applySessionHints(record, payload = {}, sessionHints = {}, sessionKey = "") {
  const identity = parseJobIdentity(payload.url || record.url, sessionHints);
  const jobId =
    sessionHints.jobId ||
    payload.jobId ||
    payload.workdayRequisitionId ||
    identity?.jobId ||
    "";

  if (jobId) {
    record.jobId = normalizeJobId(jobId);
    record.workdayRequisitionId = record.jobId;
    record.requisitionId = record.jobId;
  }
  if (sessionKey) record.jobSessionKey = sessionKey;
  if (identity?.platform) record.atsPlatform = identity.platform;
}

async function findExistingRecord(url, title, tabId, records, sessionKey, sessionHints = {}) {
  const existingId = await getActiveRecordId(tabId);
  const byTab = existingId ? records.find((record) => record.id === existingId) : null;

  if (byTab && isSameWorkdayTenant(byTab.url, url, {
    ...sessionHints,
    allowSameCompanyFlow: true,
    existingJobId: byTab.jobId || byTab.workdayRequisitionId || byTab.requisitionId
  })) {
    byTab.url = pickPreferredJobUrl(byTab.url, url);
    byTab.title = title || byTab.title;
    applySessionHints(byTab, { url, workdayRequisitionId: sessionHints.requisitionId }, sessionHints, sessionKey);
    return byTab;
  }

  if (byTab && recordsMatchSession(byTab, url, title, sessionKey, sessionHints)) {
    return byTab;
  }

  if (byTab && isWeakDownloadFolder(byTab.downloadFolder) && hasStableJobIdentity(url, title, sessionHints)) {
    byTab.url = pickPreferredJobUrl(byTab.url, url);
    byTab.title = title || byTab.title;
    applySessionHints(byTab, { url, workdayRequisitionId: sessionHints.requisitionId }, sessionHints, sessionKey);
    return byTab;
  }

  if (sessionKey) {
    const bySession = records.find(
      (record) => record.jobSessionKey === sessionKey && record.status !== "submitted"
    );
    if (bySession) return bySession;
  }

  const reqId = sessionHints.jobId || sessionHints.requisitionId || normalizeJobId(getWorkdayRequisitionId(url, sessionHints));
  if (reqId) {
    const reqKeySuffix = `|${reqId.toLowerCase()}`;
    const byRequisition = records.find(
      (record) =>
        record.status !== "submitted" &&
        (record.jobId === reqId ||
          record.workdayRequisitionId === reqId ||
          record.requisitionId === reqId ||
          String(record.jobSessionKey || "").toLowerCase().endsWith(reqKeySuffix))
    );
    if (byRequisition) {
      applySessionHints(byRequisition, { url, workdayRequisitionId: reqId }, sessionHints, sessionKey);
      return byRequisition;
    }
  }

  return null;
}

function recordsMatchSession(record, url, title, sessionKey, sessionHints = {}) {
  const nextKey = sessionKey || getJobSessionKey(url, title, sessionHints);
  if (record.jobSessionKey && nextKey) return record.jobSessionKey === nextKey;
  return isSameJobUrl(record.url, url);
}

function isSameJobUrl(existingUrl, nextUrl) {
  try {
    const a = new URL(existingUrl);
    const b = new URL(nextUrl);
    if (a.origin !== b.origin) return false;
    return a.pathname === b.pathname || b.href.startsWith(a.href.split("#")[0]);
  } catch {
    return existingUrl === nextUrl;
  }
}

async function updateJobMeta(payload, tabId) {
  payload = enrichJobPagePayload(payload);
  const recordId = payload?.recordId || (await getActiveRecordId(tabId));
  if (!recordId) return { ok: false, error: "No active record" };

  const records = await getRecords();
  const record = records.find((r) => r.id === recordId);
  if (!record) return { ok: false, error: "Record not found" };

  if (payload.url) record.url = pickPreferredJobUrl(record.url, payload.url);
  if (payload.title) record.title = payload.title;

  if (payload.jobDescription && payload.jobDescription.length > (record.jobDescription || "").length) {
    record.jobDescription = payload.jobDescription;
  }

  record.updatedAt = new Date().toISOString();
  const settings = await getSettings();
  const sessionHints = getSessionHints(payload);
  applySessionHints(record, payload, sessionHints, getJobSessionKey(record.url, record.title, sessionHints));

  const validationPayload = {
    ...payload,
    title: payload.title || record.title,
    jobDescription: payload.jobDescription || record.jobDescription
  };

  if (!isTrackableJobPage(validationPayload) && !payload.hasApplicationForm) {
    if ((record.captures || []).length > 0 || (record.stepCount || 0) > 0) {
      assignDownloadPaths(record, settings);
      await saveRecord(record);
      notifyRecordUpdated(record);
      return { ok: true, record };
    }
    await purgeInvalidJobRecord(record, tabId, validationPayload);
    return { ok: false, skipped: true, reason: getSkipReason(validationPayload) };
  }

  assignDownloadPaths(record, settings);
  await saveRecord(record);
  notifyRecordUpdated(record);
  return { ok: true, record };
}

function scheduleDeferredJobJsonExport(recordId, { refreshJson = false } = {}) {
  void (async () => {
    try {
      const records = await getRecords();
      const record = records.find((item) => item.id === recordId);
      if (!record) return;

      const settings = await getSettings();
      if (!record.jsonExportedAt) {
        await ensureJobFolder(record, settings);
      } else if (refreshJson) {
        await refreshJobJsonExport(record, settings);
        record.jsonExportedAt = new Date().toISOString();
        await saveRecord(record);
        notifyRecordUpdated(record);
      }
    } catch (err) {
      console.warn("[Bid Track] Deferred JSON export failed:", err.message);
    }
  })();
}

async function refreshJobJsonExport(record, settings) {
  if (!record?.jsonFileName || settings.autoSaveJson === false) return;
  const backend = await getArtifactBackend(settings);
  await backend.removeArtifact(record.jsonFileName);
  await downloadJsonExport(record, record.jsonFileName, settings);
  record.jsonExportedAt = new Date().toISOString();
  record.downloadFolderLocked = true;
}

async function getActiveRecordForTab(tabId) {
  if (!tabId) return { ok: false, record: null };
  const recordId = await getActiveRecordId(tabId);
  if (!recordId) return { ok: true, record: null };
  const records = await getRecords();
  const record = records.find((r) => r.id === recordId) || null;
  return { ok: true, record };
}

async function capturePage(payload, tabId) {
  payload = enrichJobPagePayload(payload);
  const settings = await getSettings();
  const trigger = payload?.trigger || "step";
  const recordId = payload?.recordId;

  const records = await getRecords();
  const record = records.find((r) => r.id === recordId);
  if (!record) return { ok: false, error: "Record not found" };

  if (!isTrackableJobPage(payload)) {
    return { ok: false, error: getSkipReason(payload) || "This job page looks expired or invalid" };
  }

  const targetTabId = tabId || payload?.tabId;
  if (!targetTabId) return { ok: false, error: "No tab for screenshot" };

  if (captureQueue.get(targetTabId)) {
    return { ok: false, skipped: true, reason: "Capture already in progress" };
  }

  captureQueue.set(targetTabId, true);
  try {
    const step = record.stepCount + 1;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    assignDownloadPaths(record, settings);
    const jobFolder = record.downloadFolder;
    const screenshotFileName = `${jobFolder}/step${step}_${trigger}_${timestamp}.png`;
    const jsonFileName = record.jsonFileName;
    const captureId = `step_${step}`;

    let dataUrl;
    let fullPage = true;
    try {
      dataUrl = await captureFullPageScreenshot(targetTabId);
    } catch (err) {
      console.warn("[Bid Track] Full page capture failed, using viewport:", err.message);
      const tab = await chrome.tabs.get(targetTabId);
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      fullPage = false;
    }

    const capturedAt = new Date();
    const b2Upload = await uploadScreenshot({
      jobFolder,
      step,
      trigger,
      capturedAt,
      dataUrl,
      jobUrl: record.url,
      jobTitle: record.title
    });
    const b2FileName = b2Upload.ok ? b2Upload.fileName : "";

    const capture = {
      id: captureId,
      step,
      trigger,
      pageUrl: payload?.pageUrl || record.url,
      screenshotFileName,
      b2FileName,
      b2Error: b2Upload.ok ? "" : b2Upload.error,
      fullPage,
      capturedAt: capturedAt.toISOString()
    };

    record.stepCount = step;
    record.captures = [...(record.captures || []), capture];
    record.jsonFileName = jsonFileName;
    record.updatedAt = new Date().toISOString();

    if (trigger === "submit") {
      record.status = "submitted";
      record.submittedAt = new Date().toISOString();
    }

    if (payload?.jobDescription && payload.jobDescription.length > (record.jobDescription || "").length) {
      record.jobDescription = payload.jobDescription;
    }
    if (payload?.url) record.url = payload.url;
    if (payload?.title) record.title = payload.title;
    assignDownloadPaths(record, settings);

    await saveScreenshot(record.id, captureId, dataUrl);
    record.downloadFolderLocked = true;
    await saveRecord(record);

    let localSave = null;
    if (settings.autoSaveScreenshots !== false) {
      const backend = await getArtifactBackend();
      localSave = await backend.saveScreenshot({
        dataUrl,
        relativePath: screenshotFileName
      });
    }

    notifyRecordUpdated(record);

    return {
      ok: true,
      record,
      capture,
      fileName: screenshotFileName,
      b2FileName,
      b2Upload,
      jsonFileName,
      fullPage,
      localSave
    };
  } finally {
    captureQueue.delete(targetTabId);
  }
}

const UPLOAD_TIMEOUT_MS = 60000;

// Asks the backend for a signed link, PUTs the PNG to it and confirms it. Never throws: failures are reported in the result.
async function uploadScreenshot({ jobFolder, step, trigger, capturedAt, dataUrl, jobUrl, jobTitle }) {
  if (!(await getAuth())) return { ok: false, error: "not logged in" };
  try {
    const job = String(jobFolder || "").split("/").filter(Boolean).pop() || "job";
    const { url, key, headers } = await getUploadUrl({
      job,
      step,
      trigger,
      capturedAt: localIsoWithOffset(capturedAt),
      jobUrl,
      jobTitle
    });
    const body = await (await fetch(dataUrl)).blob();
    const response = await fetch(url, { method: "PUT", headers, body, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // The file is stored either way; an unconfirmed upload only stays out of the bid's counts.
    await confirmUpload(key).catch((err) => console.warn("[Bid Track] Could not confirm the upload:", err.message));
    return { ok: true, fileName: key };
  } catch (err) {
    if (err?.name === "TimeoutError") return { ok: false, error: `no answer in ${UPLOAD_TIMEOUT_MS / 1000} s` };
    return { ok: false, error: err.message || "unknown error" };
  }
}

const CDP_MAX_DIMENSION = 16384;
const SCROLL_SETTLE_MS = 220;
const SCROLL_OVERLAP_PX = 64;

/**
 * Full-page capture rebuilt from scratch.
 *
 * Chrome's Page.captureScreenshot with captureBeyondViewport + a tall clip often
 * repeats the visible viewport down the image. The reliable CDP path is to resize
 * the viewport to the page content via Emulation.setDeviceMetricsOverride, then
 * capture the (now full-page) viewport. Scroll-and-stitch is the fallback.
 */
async function captureFullPageScreenshot(tabId) {
  const pageInfo = await preparePageForCapture(tabId);
  try {
    try {
      return await captureFullPageWithExpandedViewport(tabId, pageInfo);
    } catch (cdpErr) {
      console.warn("[Bid Track] Expanded-viewport CDP capture failed:", cdpErr.message);
      return await captureFullPageByScrolling(tabId, pageInfo);
    }
  } finally {
    await restorePageAfterCapture(tabId).catch(() => {});
  }
}

async function preparePageForCapture(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const html = document.documentElement;
      const body = document.body;

      const uiNodes = Array.from(
        document.querySelectorAll(
          ".btrack-capture-btn, .btrack-page-badge, .btrack-toast"
        )
      );
      const uiStyles = uiNodes.map((node) => ({
        node,
        visibility: node.style.visibility,
        pointerEvents: node.style.pointerEvents
      }));
      uiStyles.forEach(({ node }) => {
        node.style.visibility = "hidden";
        node.style.pointerEvents = "none";
      });

      html.style.setProperty("scroll-behavior", "auto", "important");
      body?.style?.setProperty("scroll-behavior", "auto", "important");

      const scrollRoot = (() => {
        const doc = document.scrollingElement || html;
        if ((doc.scrollHeight || 0) > (doc.clientHeight || 0) + 2) {
          return { kind: "window", scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight };
        }

        let best = null;
        const nodes = document.querySelectorAll("body *");
        for (const el of nodes) {
          const style = window.getComputedStyle(el);
          const canScroll =
            /(auto|scroll|overlay)/.test(style.overflowY) ||
            /(auto|scroll|overlay)/.test(style.overflow);
          if (!canScroll) continue;
          const delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
          if (delta < 80) continue;
          if (!best || delta > best.delta) {
            best = {
              kind: "element",
              el,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              delta
            };
          }
        }
        return best || {
          kind: "window",
          scrollHeight: Math.max(doc.scrollHeight || 0, body?.scrollHeight || 0, html.offsetHeight || 0),
          clientHeight: window.innerHeight
        };
      })();

      window.__btrackCapturePrep = {
        scrollX: window.scrollX,
        scrollY:
          scrollRoot.kind === "element" && scrollRoot.el
            ? scrollRoot.el.scrollTop
            : window.scrollY,
        htmlOverflow: html.style.overflow,
        bodyOverflow: body?.style.overflow || "",
        htmlScrollBehavior: html.style.scrollBehavior,
        bodyScrollBehavior: body?.style.scrollBehavior || "",
        scrollRootKind: scrollRoot.kind,
        scrollRootEl: scrollRoot.el || null,
        expandedStyles: [],
        uiStyles
      };

      // Unroll nested scrollers so CDP / layout metrics see the full content height.
      const expandEl = (el) => {
        if (!el || el === document.documentElement) return;
        const style = window.getComputedStyle(el);
        window.__btrackCapturePrep.expandedStyles.push({
          el,
          height: el.style.height,
          maxHeight: el.style.maxHeight,
          overflow: el.style.overflow,
          overflowY: el.style.overflowY
        });
        if (el.scrollHeight > el.clientHeight + 2) {
          el.style.setProperty("height", `${el.scrollHeight}px`, "important");
          el.style.setProperty("max-height", "none", "important");
        }
        if (/(auto|scroll|overlay|hidden)/.test(style.overflowY) || /(auto|scroll|overlay|hidden)/.test(style.overflow)) {
          el.style.setProperty("overflow", "visible", "important");
          el.style.setProperty("overflow-y", "visible", "important");
        }
      };

      if (scrollRoot.kind === "element" && scrollRoot.el) {
        let node = scrollRoot.el;
        while (node && node !== document.documentElement) {
          expandEl(node);
          node = node.parentElement;
        }
        expandEl(body);
      }

      window.scrollTo(0, 0);

      const measuredHeight = Math.max(
        html.scrollHeight || 0,
        body?.scrollHeight || 0,
        html.offsetHeight || 0,
        body?.offsetHeight || 0,
        scrollRoot.scrollHeight || 0,
        window.innerHeight || 0
      );

      return {
        scrollHeight: measuredHeight,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        dpr: window.devicePixelRatio || 1,
        scrollRootKind: scrollRoot.kind,
        scrollRootClientHeight: scrollRoot.clientHeight || window.innerHeight
      };
    }
  });

  await sleep(SCROLL_SETTLE_MS);
  return result;
}

async function restorePageAfterCapture(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const prep = window.__btrackCapturePrep;
      if (!prep) return;

      const html = document.documentElement;
      const body = document.body;
      html.style.overflow = prep.htmlOverflow;
      html.style.scrollBehavior = prep.htmlScrollBehavior || "";
      if (body) {
        body.style.overflow = prep.bodyOverflow;
        body.style.scrollBehavior = prep.bodyScrollBehavior || "";
      }

      (prep.uiStyles || []).forEach((item) => {
        if (!item?.node) return;
        item.node.style.visibility = item.visibility || "";
        item.node.style.pointerEvents = item.pointerEvents || "";
      });

      (prep.expandedStyles || []).forEach((item) => {
        if (!item?.el) return;
        item.el.style.height = item.height || "";
        item.el.style.maxHeight = item.maxHeight || "";
        item.el.style.overflow = item.overflow || "";
        item.el.style.overflowY = item.overflowY || "";
      });

      if (prep.scrollRootKind === "element" && prep.scrollRootEl) {
        prep.scrollRootEl.scrollTop = prep.scrollY || 0;
      } else {
        window.scrollTo(prep.scrollX || 0, prep.scrollY || 0);
      }
      delete window.__btrackCapturePrep;
    }
  });
}

function clampDimension(value, fallback = 1) {
  const n = Math.ceil(Number(value) || fallback);
  return Math.min(Math.max(n, 1), CDP_MAX_DIMENSION);
}

/**
 * Expand the browser viewport to the full document size, then capture once.
 * Avoids captureBeyondViewport clip tiling that repeats one viewport frame.
 */
async function captureFullPageWithExpandedViewport(tabId, pageInfo) {
  const target = { tabId };
  let attached = false;

  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");

    const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
    const content = metrics.cssContentSize || metrics.contentSize || {};
    const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};

    let width = clampDimension(pageInfo?.innerWidth || content.width || layout.clientWidth || 1280);
    let height = clampDimension(
      Math.max(
        pageInfo?.scrollHeight || 0,
        content.height || 0,
        layout.clientHeight || 0,
        pageInfo?.innerHeight || 0
      )
    );

    // Prefer DOM scroll height when CDP content size is inflated (common on SPAs).
    if (pageInfo?.scrollHeight > 0 && content.height > pageInfo.scrollHeight * 1.35) {
      height = clampDimension(pageInfo.scrollHeight);
    }

    if ((pageInfo?.scrollHeight || 0) > CDP_MAX_DIMENSION) {
      throw new Error(`Page taller than CDP limit (${pageInfo.scrollHeight}px)`);
    }

    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width,
      height,
      deviceScaleFactor: 1,
      screenWidth: width,
      screenHeight: height
    });
    await sleep(300);

    const metricsAfter = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
    const contentAfter = metricsAfter.cssContentSize || metricsAfter.contentSize || {};
    const nextWidth = clampDimension(Math.max(width, contentAfter.width || 0, pageInfo?.innerWidth || 0));
    const nextHeight = clampDimension(
      Math.max(height, Math.min(contentAfter.height || 0, pageInfo?.scrollHeight || height), pageInfo?.scrollHeight || 0)
    );

    if (nextWidth !== width || nextHeight !== height) {
      width = nextWidth;
      height = nextHeight;
      await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width,
        height,
        deviceScaleFactor: 1,
        screenWidth: width,
        screenHeight: height
      });
      await sleep(180);
    }

    const screenshot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      // Viewport already matches page size — do not use tall beyond-viewport clips.
      captureBeyondViewport: false
    });

    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});

    if (!screenshot?.data) throw new Error("Empty CDP screenshot");
    return `data:image/png;base64,${screenshot.data}`;
  } finally {
    if (attached) {
      await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

async function captureFullPageByScrolling(tabId, pageInfo) {
  const tab = await chrome.tabs.get(tabId);
  const viewportHeight = Math.max(1, Math.floor(pageInfo?.innerHeight || 800));
  const totalHeight = Math.max(viewportHeight, Math.floor(pageInfo?.scrollHeight || viewportHeight));

  if (totalHeight <= viewportHeight + 2) {
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  }

  const step = Math.max(1, viewportHeight - SCROLL_OVERLAP_PX);
  const maxY = Math.max(0, totalHeight - viewportHeight);
  const targets = [];
  for (let y = 0; y < maxY; y += step) targets.push(y);
  if (!targets.length || targets[targets.length - 1] !== maxY) targets.push(maxY);

  const slices = [];
  let previousY = -1;

  for (const desiredY of targets) {
    const [{ result: actualY }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => {
        const prep = window.__btrackCapturePrep;
        if (prep?.scrollRootKind === "element" && prep.scrollRootEl) {
          prep.scrollRootEl.scrollTop = y;
          return Math.round(prep.scrollRootEl.scrollTop || 0);
        }

        window.scrollTo(0, y);
        const doc = document.scrollingElement || document.documentElement;
        return Math.round(doc.scrollTop || window.scrollY || 0);
      },
      args: [desiredY]
    });

    const scrollY = Number.isFinite(actualY) ? actualY : desiredY;

    // If the page did not actually scroll, stop — stitching identical frames
    // produces the "repeated viewport" tall image.
    if (slices.length && scrollY <= previousY + 1) {
      break;
    }

    await sleep(SCROLL_SETTLE_MS);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    slices.push({ scrollY, dataUrl });
    previousY = scrollY;

    if (scrollY >= maxY - 1) break;
  }

  if (!slices.length) throw new Error("No screenshot slices captured");
  if (slices.length === 1) return slices[0].dataUrl;

  const reachedBottom = slices[slices.length - 1].scrollY >= maxY - 2;
  if (!reachedBottom && slices.length < 2) {
    throw new Error("Page did not scroll; cannot build full-page screenshot");
  }

  return stitchViewportSlices({
    slices,
    viewportHeight,
    totalHeight: Math.max(totalHeight, slices[slices.length - 1].scrollY + viewportHeight)
  });
}

async function stitchViewportSlices({ slices, viewportHeight, totalHeight }) {
  const firstBitmap = await dataUrlToBitmap(slices[0].dataUrl);
  const scale = firstBitmap.height / viewportHeight;
  const canvasWidth = firstBitmap.width;
  const canvasHeight = Math.max(1, Math.round(totalHeight * scale));
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");
  firstBitmap.close();

  for (let i = 0; i < slices.length; i += 1) {
    const { scrollY, dataUrl } = slices[i];
    const bitmap = await dataUrlToBitmap(dataUrl);
    const destY = Math.round(scrollY * scale);
    const isLast = i === slices.length - 1;

    if (isLast && slices.length > 1) {
      const remainingCss = Math.max(1, totalHeight - scrollY);
      const drawHeight = Math.min(Math.round(remainingCss * scale), canvasHeight - destY, bitmap.height);
      const srcY = Math.max(0, bitmap.height - drawHeight);
      ctx.drawImage(bitmap, 0, srcY, bitmap.width, drawHeight, 0, destY, bitmap.width, drawHeight);
    } else {
      const drawHeight = Math.min(bitmap.height, canvasHeight - destY);
      ctx.drawImage(bitmap, 0, 0, bitmap.width, drawHeight, 0, destY, bitmap.width, drawHeight);
    }

    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function dataUrlToBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  return createImageBitmap(await response.blob());
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRecordsWithScreenshots() {
  const records = await getRecords();
  const withScreenshots = await Promise.all(
    records.map(async (record) => {
      const shots = await getRecordScreenshots(record.id);
      const latestCapture = record.captures?.[record.captures.length - 1];
      const latestDataUrl = latestCapture ? shots[latestCapture.id] : null;
      return latestDataUrl ? { ...record, latestScreenshotDataUrl: latestDataUrl } : record;
    })
  );
  return { ok: true, records: withScreenshots };
}

async function deleteRecord(id) {
  const records = await getRecords();
  const filtered = records.filter((r) => r.id !== id);
  await chrome.storage.local.set({ records: filtered });
  await deleteRecordScreenshots(id);
  return { ok: true };
}

async function downloadScreenshot(payload) {
  const records = await getRecords();
  const record = records.find((r) => r.id === payload.recordId);
  if (!record) return { ok: false, error: "Record not found" };

  const capture =
    record.captures?.find((item) => item.id === payload.captureId) ||
    record.captures?.[record.captures.length - 1];
  if (!capture) return { ok: false, error: "No capture found" };

  const dataUrl = await getScreenshot(record.id, capture.id);
  if (!dataUrl) return { ok: false, error: "No screenshot available" };

  const fileName =
    payload.fileName ||
    capture.screenshotFileName ||
    `${record.downloadFolder || "BidTrackScreenshots"}/${capture.id}.png`;
  await chrome.downloads.download({ url: dataUrl, filename: fileName, saveAs: true });
  return { ok: true, fileName };
}

async function downloadRecordJson(payload) {
  const records = await getRecords();
  const record = records.find((r) => r.id === payload.id);
  if (!record) return { ok: false, error: "Record not found" };

  const settings = await getSettings();
  assignDownloadPaths(record, settings);
  const fileName = payload.fileName || record.jsonFileName;

  await downloadJsonExport(record, fileName);
  return { ok: true, fileName };
}

function assignDownloadPaths(record, settings) {
  const rootFolder = settings?.screenshotFolder || "BidTrackScreenshots";
  const sessionHints = {
    jobId: record.jobId || record.workdayRequisitionId || record.requisitionId || "",
    requisitionId: record.workdayRequisitionId || record.requisitionId || record.jobId || ""
  };
  record.jobSessionKey =
    record.jobSessionKey || getJobSessionKey(record.url, record.title, sessionHints);
  record.companyName = getCompanyLabel(record.url, record.title);

  if (!record.downloadFolder) {
    record.downloadFolder = buildJobDownloadFolder(record, rootFolder);
  }

  record.jsonFileName = `${record.downloadFolder}/job-info.json`;
}

async function ensureJobFolder(record, settings) {
  if (record.jsonExportedAt) return;
  if (!isTrackableJobPage({ title: record.title, jobDescription: record.jobDescription })) return;
  if (settings.autoSaveJson === false) return;
  await downloadJsonExport(record, record.jsonFileName);
  record.jsonExportedAt = new Date().toISOString();
  record.downloadFolderLocked = true;
  await saveRecord(record);
}

async function purgeInvalidJobRecord(record, tabId, payload = {}) {
  const pagePayload = {
    title: payload.title || record.title,
    jobDescription: payload.jobDescription || record.jobDescription,
    pageText: payload.pageText || "",
    pageError: payload.pageError || false
  };

  if (!hasStableJobIdentity(record.url, record.title)) {
    if ((record.captures || []).length > 0 || (record.stepCount || 0) > 0) return false;
    const folder = record.downloadFolder;
    await removeFolderDownloads(folder);
    await deleteRecord(record.id);
    if (tabId) await clearActiveRecordId(tabId);
    return true;
  }

  if (isTrackableJobPage(pagePayload)) return false;
  if (record.downloadFolderLocked) return false;
  if ((record.captures || []).length > 0 || (record.stepCount || 0) > 0) return false;

  const folder = record.downloadFolder;
  await removeFolderDownloads(folder);
  await deleteRecord(record.id);
  if (tabId) await clearActiveRecordId(tabId);
  return true;
}

function getSkipReason(payload = {}) {
  if (payload.pageError || isExpiredJobPage(payload.title, payload.jobDescription, payload.pageText)) {
    return "Job expired or invalid";
  }
  if (!hasValidJobTitle(payload.title)) {
    return "Invalid job page";
  }
  if (!hasValidJobDescription(payload.jobDescription, { title: payload.title, pageText: payload.pageText })) {
    return "No job description";
  }
  return "No job description";
}

async function removeFolderDownloads(downloadFolder) {
  if (!downloadFolder) return;
  const backend = await getArtifactBackend(await getSettings());
  await backend.removeJobFolder(downloadFolder);
}

async function removeDownloadFile(filePath) {
  if (!filePath) return;
  const backend = await getArtifactBackend(await getSettings());
  await backend.removeArtifact(filePath);
}

async function downloadJsonExport(record, jsonFileName, settings) {
  const runtimeSettings = settings || (await getSettings());
  const backend = await getArtifactBackend(runtimeSettings);
  await backend.saveJson({
    jsonObject: buildRecordExport(record),
    relativePath: jsonFileName,
    record,
    settings: runtimeSettings
  });
}

function notifyRecordUpdated(record) {
  chrome.runtime.sendMessage({ type: "RECORD_UPDATED", record }).catch(() => {});
}
