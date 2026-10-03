export function normalizeApplicationKey(value) {
  return String(value || "")
    .trim()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, "");
}

export function normalizeKeyId(value) {
  return String(value || "")
    .trim()
    .replace(/[\u200b-\u200d\ufeff]/g, "");
}

export function validateBackblazeCredentials({ b2KeyId, b2ApplicationKey } = {}) {
  const keyId = normalizeKeyId(b2KeyId);
  const applicationKey = normalizeApplicationKey(b2ApplicationKey);

  if (!keyId) {
    return { ok: false, error: "Key ID missing — paste the application key ID (005…)" };
  }
  if (!/^005[a-f0-9]+$/i.test(keyId)) {
    return {
      ok: false,
      error: "Key ID must be the application key ID from Backblaze (starts with 005), not the key name"
    };
  }
  if (!applicationKey) {
    return { ok: false, error: "Application key missing — paste the secret from Backblaze and Save" };
  }
  if (!/^K005[a-zA-Z0-9+/=]+$/.test(applicationKey)) {
    return {
      ok: false,
      error:
        "Application key must be the secret from Backblaze (starts with K005). Do not use your account password."
    };
  }

  return { ok: true, b2KeyId: keyId, b2ApplicationKey: applicationKey };
}
