(function () {
  "use strict";

  // The popup may inject this script into tabs opened before the extension loaded.
  if (window.__bidTrackLoaded) return;
  window.__bidTrackLoaded = true;

  const EXCLUDED = ["linkedin.com", "indeed.com"];

  const EXPIRED_PAGE_PATTERNS = [
    /requested job could not be found/i,
    /does not exist or is no longer open/i,
    /search results page \d+ of/i,
    /the job you were looking for/i
  ];

  const INVALID_TITLE_PATTERNS = [/^about\s[-|]/i, /^error:/i, /search results page/i];

  const BOILERPLATE_DESCRIPTION_PATTERNS = [
    /equal employment opportunity/i,
    /does not discriminate against any applicant/i,
    /©\s*\d{4}/i,
    /vista global holding limited/i,
    /office \d+.*(?:dubai|uae|finance centre|finance center)/i
  ];

  let activeRecord = null;
  let initDone = false;
  let capturePending = false;
  let lastCaptureKey = "";
  let lastCaptureAt = 0;
  let lastSyncedMetaKey = "";

  function isIcimsHost() {
    return /icims\.com/i.test(location.hostname);
  }

  function getIcimsIframeDocument() {
    const iframe = document.getElementById("icims_content_iframe");
    try {
      return iframe?.contentDocument || null;
    } catch {
      return null;
    }
  }

  function isIcimsShellFrame() {
    if (window.top !== window || !isIcimsHost()) return false;
    if (!document.getElementById("icims_content_iframe")) return false;
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return bodyText.length < 120;
  }

  function isIcimsJobContentFrame() {
    if (!isIcimsHost()) return false;
    if (/[?&]in_iframe=1/i.test(location.search)) return true;
    if (document.querySelector(".iCIMS_JobContent, .iCIMS_JobPage, .iCIMS_InfoField_JobTitle, .iCIMS_MainWrapper.iCIMS_JobPage")) {
      return true;
    }
    return /\/jobs\/\d+/i.test(location.pathname) && (document.body?.innerText || "").replace(/\s+/g, " ").trim().length > 200;
  }

  function shouldBootstrapFrame() {
    if (isIcimsShellFrame()) return false;
    if (window.top !== window) {
      if (hasApplicationForm()) return true;
      if (isIcimsJobContentFrame()) return true;
      return false;
    }
    return true;
  }

  if (!shouldBootstrapFrame()) return;
  // The popup picks a frame to capture from among those that set this.
  window.__bidTrackBootstrapped = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({ ok: true, activeRecordId: activeRecord?.id || null, stepCount: activeRecord?.stepCount || 0 });
      return false;
    }
    if (message.type === "CAPTURE_NOW") {
      ready.then(() => requestPageCapture("step")).then(sendResponse);
      return true;
    }
    if (message.type === "RECORD_UPDATED" && message.record) {
      activeRecord = message.record;
    }
    return false;
  });

  const ready = bootstrap();

  function hasExtensionContext() {
    try {
      return !!chrome?.runtime?.id;
    } catch {
      return false;
    }
  }

  async function bootstrap() {
    if (isExcluded() || !hasExtensionContext()) return;

    try {
      const ping = await sendMessage({ type: "PING" });
      if (!ping?.ok) return;

      await initJobRecord();
      watchJobContent();
      watchApplicationPanel();
      watchSpaNavigation();
      watchPageLifecycle();
      initDone = true;
    } catch (err) {
      console.warn("[Bid Track] bootstrap failed:", err);
    }
  }

  function isExcluded() {
    try {
      const host = location.hostname.replace(/^www\./, "");
      return EXCLUDED.some((item) => host === item || host.endsWith("." + item));
    } catch {
      return false;
    }
  }

  function isBoilerplateDescription(text) {
    const cleaned = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleaned) return true;
    if (BOILERPLATE_DESCRIPTION_PATTERNS.filter((pattern) => pattern.test(cleaned)).length >= 2) return true;
    if (/equal employment opportunity employer/i.test(cleaned) && cleaned.length < 900) return true;
    if (/©\s*\d{4}/.test(cleaned) && !/(responsibilities|requirements|qualifications|experience|skills)/i.test(cleaned)) {
      return true;
    }
    return false;
  }

  function hasValidJobDescription(text) {
    const cleaned = String(text || "").replace(/\s+/g, " ").trim();
    if (cleaned.length < 50) return false;
    return !isBoilerplateDescription(cleaned);
  }

  function hasValidJobTitle(title) {
    const cleaned = String(title || "").replace(/\s+/g, " ").trim();
    if (cleaned.length < 5) return false;
    return !INVALID_TITLE_PATTERNS.some((pattern) => pattern.test(cleaned));
  }

  function collectDocumentText(root = document, depth = 0) {
    if (!root || depth > 4) return "";
    let text = root.body?.innerText || "";
    for (const iframe of root.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument) {
          text += ` ${collectDocumentText(iframe.contentDocument, depth + 1)}`;
        }
      } catch {
        // Cross-origin iframe
      }
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function getPageContext() {
    const visibleText = collectDocumentText();
    const headline =
      document.querySelector("h1")?.innerText?.trim() ||
      [...document.querySelectorAll("h1, h2, .iCIMS_ErrorMsg, .error, [class*='error']")]
        .map((el) => el.innerText?.trim())
        .find(Boolean) ||
      "";
    const alertText = [...document.querySelectorAll('[role="alert"], .alert, [class*="error"], [class*="Error"]')]
      .map((el) => el.innerText?.trim())
      .filter(Boolean)
      .join(" ");
    const pageText = `${headline} ${alertText} ${visibleText}`.replace(/\s+/g, " ").trim().slice(0, 2000);
    const pageError = EXPIRED_PAGE_PATTERNS.some((pattern) => pattern.test(pageText));
    return { headline, pageText, pageError };
  }

  function detectAtsPlatform() {
    const host = location.hostname.toLowerCase();
    if (/myworkdayjobs\.com/.test(host)) return "workday";
    if (/icims\.com/.test(host)) return "icims";
    if (/greenhouse\.io/.test(host)) return "greenhouse";
    if (/lever\.co/.test(host)) return "lever";
    if (/ashbyhq\.com/.test(host)) return "ashby";
    if (/smartrecruiters\.com/.test(host)) return "smartrecruiters";
    if (/jobvite\.com/.test(host)) return "jobvite";
    return "generic";
  }

  function isKnownAtsPage() {
    return detectAtsPlatform() !== "generic" || /career|job|apply|greenhouse|lever|workday|icims/i.test(location.href);
  }

  function isWorkdayPage() {
    return detectAtsPlatform() === "workday";
  }

  function decodeHtmlEntities(text) {
    const el = document.createElement("textarea");
    el.innerHTML = text;
    return el.value;
  }

  function stripHtml(text) {
    const el = document.createElement("div");
    el.innerHTML = text;
    return (el.textContent || el.innerText || "").replace(/\s+/g, " ").trim();
  }

  function extractJsonLdJobPosting() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "");
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const type = item?.["@type"] || item?.type || "";
          if (String(type).toLowerCase() !== "jobposting") continue;
          const title = String(item.title || item.identifier?.name || "").trim();
          const requisitionId = String(item.identifier?.value || "").trim();
          const rawDescription = String(item.description || "").trim();
          const description = rawDescription.includes("<")
            ? stripHtml(rawDescription)
            : decodeHtmlEntities(rawDescription).replace(/\s+/g, " ").trim();
          if (title || description || requisitionId) {
            return { title, description, requisitionId };
          }
        }
      } catch {
        // Ignore malformed JSON-LD blocks.
      }
    }
    return null;
  }

  function getPageTitle() {
    if (isIcimsHost()) {
      for (const root of [document, getIcimsIframeDocument()].filter(Boolean)) {
        const icimsTitle = root
          .querySelector(".iCIMS_InfoField_JobTitle, .iCIMS_JobHeader h1, .iCIMS_MainWrapper h1, h1")
          ?.innerText?.trim();
        if (icimsTitle && hasValidJobTitle(icimsTitle)) return icimsTitle;
      }

      const fromDocTitle = String(document.title || "")
        .replace(/\s+/g, " ")
        .split(/\s+\|\s+|\s+ in /i)[0]
        ?.trim();
      if (fromDocTitle && hasValidJobTitle(fromDocTitle)) return fromDocTitle;

      const slugMatch = location.pathname.match(/\/jobs\/\d+\/([^/]+)/i);
      if (slugMatch?.[1]) {
        const slugTitle = slugMatch[1]
          .replace(/-/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase());
        if (hasValidJobTitle(slugTitle)) return slugTitle;
      }
    }

    const docTitle = String(document.title || "").replace(/\s+/g, " ").trim();
    if (docTitle && hasValidJobTitle(docTitle)) return docTitle;

    const jsonLd = extractJsonLdJobPosting();
    if (jsonLd?.title && hasValidJobTitle(jsonLd.title)) return jsonLd.title;

    const workdayTitle = document
      .querySelector('[data-automation-id="jobPostingHeader"]')
      ?.innerText?.trim();
    if (workdayTitle && hasValidJobTitle(workdayTitle)) return workdayTitle;

    const greenhouseTitle = document.querySelector(".app-title, .job-post h1, .posting-headline h2")?.innerText?.trim();
    if (greenhouseTitle && hasValidJobTitle(greenhouseTitle)) return greenhouseTitle;

    const leverTitle = document.querySelector(".posting-headline h2, .posting-title")?.innerText?.trim();
    if (leverTitle && hasValidJobTitle(leverTitle)) return leverTitle;

    const headline = document.querySelector("h1")?.innerText?.trim();
    if (headline && hasValidJobTitle(headline)) return headline;

    return docTitle || workdayTitle || headline || jsonLd?.title || "";
  }

  function getJobIdentityHints() {
    const jsonLd = extractJsonLdJobPosting();
    const platform = detectAtsPlatform();
    let jobId = jsonLd?.requisitionId || "";

    if (!jobId) {
      const reqMatch = location.href.match(/_?([Rr])(-?)(\d+)/i);
      if (reqMatch) jobId = `R-${reqMatch[3]}`;
    }

    if (!jobId && platform === "greenhouse") {
      const ghJid = new URL(location.href).searchParams.get("gh_jid");
      if (ghJid) jobId = ghJid;
    }

    if (!jobId) {
      const numeric = location.pathname.match(/\/jobs\/(\d{4,})/i);
      if (numeric) jobId = numeric[1];
    }

    if (!jobId && platform === "icims") {
      const icims = location.pathname.match(/\/jobs\/(\d+)/i);
      if (icims) jobId = icims[1];
    }

    return {
      jobId: jobId || "",
      requisitionId: jobId || "",
      workdayRequisitionId: jobId || "",
      atsPlatform: platform
    };
  }

  function getWorkdayRequisitionId() {
    return getJobIdentityHints().jobId;
  }

  function buildJobPayload(extra = {}) {
    const page = getPageContext();
    const identity = getJobIdentityHints();
    return {
      url: location.href,
      title: getPageTitle(),
      jobDescription: extractJobDescription(),
      jobId: identity.jobId,
      requisitionId: identity.requisitionId,
      workdayRequisitionId: identity.workdayRequisitionId,
      atsPlatform: identity.atsPlatform,
      hasApplicationForm: hasApplicationForm(),
      pageText: page.pageText,
      pageError: page.pageError,
      ...extra
    };
  }

  function applyRecordResult(result) {
    if (result?.ok && result.record) {
      activeRecord = result.record;
      return;
    }

    if (
      result?.reason === "No job description" ||
      result?.reason === "No job identity" ||
      result?.reason === "Job expired or invalid" ||
      result?.reason === "Invalid job page"
    ) {
      activeRecord = null;
    }
  }

  async function initJobRecord() {
    const result = await sendMessage({
      type: "INIT_JOB_RECORD",
      payload: buildJobPayload()
    });

    applyRecordResult(result);
    if (!activeRecord?.id) {
      await syncActiveRecordFromBackground();
    }
  }

  async function syncActiveRecordFromBackground() {
    const response = await sendMessage({ type: "GET_ACTIVE_RECORD" });
    if (response?.ok && response.record) {
      activeRecord = response.record;
    }
  }

  async function ensureActiveRecord(force = false) {
    if (activeRecord?.id && hasValidJobDescription(activeRecord.jobDescription) && !force) {
      return activeRecord;
    }

    const result = await sendMessage({
      type: "INIT_JOB_RECORD",
      payload: buildJobPayload({ hasApplicationForm: force || hasApplicationForm() })
    });

    applyRecordResult(result);
    return activeRecord;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeFieldText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function hasApplicationForm(root) {
    const scope = root || document;
    return !!scope.querySelector(
      'form input:not([type="hidden"]):not([type="file"]), form textarea, form select, input:not([type="hidden"]):not([type="file"]), textarea, select'
    );
  }

  function watchJobContent() {
    const handleContent = debounce(async () => {
      if (!initDone) return;

      const title = getPageTitle();
      const description = extractJobDescription();
      const ready =
        hasValidJobTitle(title) &&
        hasValidJobDescription(description) &&
        !getPageContext().pageError;

      if (!ready) return;

      if (!activeRecord?.id || !hasValidJobDescription(activeRecord.jobDescription)) {
        await ensureActiveRecord(true);
      } else {
        const metaKey = `${location.href}|${title}|${description.length}|${getJobIdentityHints().jobId || ""}`;
        if (metaKey !== lastSyncedMetaKey) {
          lastSyncedMetaKey = metaKey;
          await refreshJobMeta();
        }
      }
    }, 400);

    const observer = new MutationObserver(handleContent);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    [300, 800, 1500, 3000, 6000, 10000].forEach((delay) => setTimeout(handleContent, delay));
    if (isKnownAtsPage()) {
      setInterval(handleContent, 2500);
    }
  }

  function watchSpaNavigation() {
    const rerun = debounce(async () => {
      if (!initDone) return;
      await initJobRecord();
    }, 500);

    window.addEventListener("popstate", rerun);

    const wrapHistory = (method) => {
      const original = history[method];
      if (typeof original !== "function") return;
      history[method] = function (...args) {
        const result = original.apply(this, args);
        rerun();
        return result;
      };
    };

    wrapHistory("pushState");
    wrapHistory("replaceState");
  }

  function watchApplicationPanel() {
    const handlePanel = debounce(async () => {
      if (!initDone || !hasApplicationForm()) return;
      await ensureActiveRecord(true);
      const title = getPageTitle();
      const description = extractJobDescription();
      const metaKey = `${location.href}|${title}|${description.length}|${getJobIdentityHints().jobId || ""}`;
      if (metaKey !== lastSyncedMetaKey) {
        lastSyncedMetaKey = metaKey;
        await refreshJobMeta();
      }
    }, 400);

    const observer = new MutationObserver(handlePanel);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"]
    });

    [500, 1500, 3000, 6000].forEach((delay) => setTimeout(handlePanel, delay));
    setInterval(handlePanel, 3000);
  }

  function watchPageLifecycle() {
    const recover = debounce(async () => {
      if (!initDone) return;
      if (!activeRecord?.id) {
        await syncActiveRecordFromBackground();
      }
      if (!activeRecord?.id) {
        await initJobRecord();
      } else {
        await ensureActiveRecord(true);
      }
    }, 350);

    window.addEventListener("pageshow", recover);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recover();
    });  }

  // Captures the tab for the active job record. Returns
  // { ok: true, step, fullPage, upload: { ok, error } } or { ok: false, error } for the popup to show.
  async function requestPageCapture(trigger) {
    const captureKey = `${trigger}:${location.href}:${activeRecord?.stepCount || 0}`;
    const now = Date.now();
    if (capturePending) return { ok: false, error: "A screenshot is already being saved" };
    if (lastCaptureKey === captureKey && now - lastCaptureAt < 1500) {
      return { ok: false, error: "Just saved — wait a moment" };
    }

    await ensureActiveRecord(true);
    if (!activeRecord?.id) return { ok: false, error: "No job detected on this page" };

    capturePending = true;
    let result;
    try {
      const page = getPageContext();
      // Full-page stitching plus the upload can take a while; the default 12 s is too short.
      result = await sendMessage(
        {
          type: "CAPTURE_PAGE",
          payload: {
            recordId: activeRecord.id,
            trigger,
            pageUrl: location.href,
            title: getPageTitle(),
            jobDescription: extractJobDescription(),
            ...getJobIdentityHints(),
            url: location.href,
            pageText: page.pageText,
            pageError: page.pageError
          }
        },
        120000
      );
    } finally {
      capturePending = false;
    }

    if (result?.ok) {
      activeRecord = result.record;
      lastCaptureKey = captureKey;
      lastCaptureAt = Date.now();
      return {
        ok: true,
        step: result.capture?.step || activeRecord.stepCount,
        fullPage: !!result.fullPage,
        upload: { ok: !!result.b2Upload?.ok, error: result.b2Upload?.error || "" }
      };
    }
    if (result?.skipped) return { ok: false, error: result.reason || "A screenshot is already being saved" };
    return { ok: false, error: result?.error || "Could not capture screenshot" };
  }

  async function refreshJobMeta() {
    if (!activeRecord?.id) return;
    const page = getPageContext();
    const result = await sendMessage({
      type: "UPDATE_JOB_META",
      payload: {
        recordId: activeRecord.id,
        url: location.href,
        title: getPageTitle(),
        jobDescription: extractJobDescription(),
        ...getJobIdentityHints(),
        hasApplicationForm: hasApplicationForm(),
        pageText: page.pageText,
        pageError: page.pageError
      }
    });
    if (result?.ok && result.record) {
      activeRecord = result.record;
    } else if (
      result?.reason === "No job description" &&
      !(activeRecord?.captures || []).length &&
      !(activeRecord?.stepCount || 0)
    ) {
      activeRecord = null;
    }
  }

  function extractJobDescriptionFromRoot(root) {
    if (!root) return "";

    const selectors = [
      ".iCIMS_JobContent",
      ".iCIMS_JobPage .iCIMS_InfoMsg",
      ".iCIMS_MainWrapper.iCIMS_JobPage",
      '[data-automation-id="jobPostingDescription"]',
      '[data-automation-id="jobPosting.jobDescription"]',
      '[data-automation-id="jobPostingPage"]',
      "#content .job-post",
      "#content .job__description",
      "#job-description",
      "#job-description .content",
      '[data-qa="job-description"]',
      ".job-post-content",
      ".job-post .body",
      ".posting-page .section-wrapper .content",
      ".posting .posting-description",
      ".content .job-post",
      ".opening .description",
      '[class*="job-description"]',
      '[class*="JobDescription"]',
      '[id*="job-description"]',
      '[data-testid*="description"]',
      "#job-content",
      "#job-description",
      '[class*="posting-description"]',
      '[class*="posting"]',
      '[id*="description-text"]'
    ];

    for (const sel of selectors) {
      const el = root.querySelector(sel);
      const text = extractReadableText(el);
      if (text.length > 100 && !isBoilerplateDescription(text)) return text.slice(0, 12000);
    }

    const meta = root.querySelector?.('meta[name="description"]');
    if (meta?.content && meta.content.length > 80 && !isBoilerplateDescription(meta.content)) {
      return meta.content.slice(0, 12000);
    }

    const paragraphs = [...root.querySelectorAll("main p, article p, .content p, p")]
      .filter((el) => !el.closest("footer, header, nav, [role='contentinfo'], [class*='footer'], [class*='error'], [class*='alert']"))
      .map((p) => extractReadableText(p))
      .filter((t) => t.length > 80 && !isBoilerplateDescription(t))
      .slice(0, 6)
      .join("\n\n");

    if (paragraphs && !isBoilerplateDescription(paragraphs)) {
      return paragraphs.slice(0, 12000);
    }

    return "";
  }

  function extractJobDescription() {
    const page = getPageContext();
    const title = getPageTitle();
    if (page.pageError || !hasValidJobTitle(title)) return "";

    const jsonLd = extractJsonLdJobPosting();
    if (jsonLd?.description?.length > 50 && !isBoilerplateDescription(jsonLd.description)) {
      return jsonLd.description.slice(0, 12000);
    }

    const roots = [document];
    const icimsFrame = getIcimsIframeDocument();
    if (icimsFrame) roots.push(icimsFrame);

    for (const root of roots) {
      const description = extractJobDescriptionFromRoot(root);
      if (description) return description;
    }

    return "";
  }

  function extractReadableText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, iframe, nav, footer, form").forEach((node) => node.remove());
    return (clone.innerText || "").replace(/\s+/g, " ").trim();
  }

  function sendMessage(message, timeoutMs = 12000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, error: "Extension timed out. Try again." });
      }, timeoutMs);

      try {
        if (!chrome.runtime?.id) {
          finish({ ok: false, error: "Extension reloaded. Refresh this page." });
          return;
        }

        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          finish(response || { ok: false, error: "No response" });
        });
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    });
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }
})();
