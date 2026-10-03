export function sanitizePathSegment(value, fallback = "default") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export function applyRequiredPrefix(objectKey, namePrefix) {
  const required = String(namePrefix || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const key = String(objectKey || "").replace(/^\/+/, "");
  if (!required) return key;
  if (key === required || key.startsWith(`${required}/`)) return key;
  return `${required}/${key}`;
}
