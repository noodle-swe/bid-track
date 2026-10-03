export function sanitizeFolderName(name) {
  return String(name || "job")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80) || "job";
}

export function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").replace(/\./g, "_");
  } catch {
    return "unknown";
  }
}
