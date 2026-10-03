/**
 * Job artifact storage — local Downloads only.
 *
 * Relative path:
 *   {rootFolder}/{jobFolder}/step{n}_{trigger}_{timestamp}.png
 */

export async function getArtifactBackend() {
  return createLocalDownloadBackend();
}

function createLocalDownloadBackend() {
  return {
    name: "local",

    async saveScreenshot({ dataUrl, relativePath }) {
      await chrome.downloads.download({
        url: dataUrl,
        filename: relativePath,
        saveAs: false,
        conflictAction: "overwrite"
      });
      return { ok: true, backend: "local", path: relativePath };
    },

    async saveJson({ jsonObject, relativePath }) {
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(jsonObject, null, 2))}`;
      await chrome.downloads.download({
        url,
        filename: relativePath,
        saveAs: false,
        conflictAction: "overwrite"
      });
      return { ok: true, backend: "local", path: relativePath };
    },

    async removeArtifact(relativePath) {
      await removeDownloadByRelativePath(relativePath);
      return { ok: true };
    },

    async removeJobFolder(downloadFolder) {
      await removeDownloadsInFolder(downloadFolder);
      return { ok: true };
    }
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function removeDownloadByRelativePath(relativePath) {
  if (!relativePath) return;

  const target = String(relativePath).replace(/\\/g, "/").toLowerCase();
  const base = target.split("/").pop();
  if (!base) return;

  const items = await chrome.downloads.search({
    filenameRegex: `${escapeRegex(base)}$`,
    limit: 40,
    orderBy: ["-startTime"]
  });

  for (const item of items) {
    const path = String(item.filename || "").replace(/\\/g, "/").toLowerCase();
    if (!path.endsWith(target) && !path.endsWith(`/${base}`)) continue;

    try {
      if (item.exists) await chrome.downloads.removeFile(item.id);
    } catch (err) {
      console.warn("[Bid Track Local] could not remove downloaded file:", err);
    }

    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  }
}

async function removeDownloadsInFolder(downloadFolder) {
  if (!downloadFolder) return;

  const needle = downloadFolder.replace(/\\/g, "/").toLowerCase();
  const folderName = needle.split("/").filter(Boolean).pop() || needle;
  const items = await chrome.downloads.search({
    query: [folderName],
    limit: 200,
    orderBy: ["-startTime"]
  });

  for (const item of items) {
    const path = String(item.filename || "").replace(/\\/g, "/").toLowerCase();
    if (!path.includes(needle)) continue;

    try {
      if (item.exists) await chrome.downloads.removeFile(item.id);
    } catch (err) {
      console.warn("[Bid Track Local] could not remove downloaded file:", err);
    }

    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  }
}
