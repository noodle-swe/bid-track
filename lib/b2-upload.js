/**
 * Backblaze B2 native upload.
 * A "folder" is only the prefix of the file name, so the date has to be written
 * into the object key here. B2 records an upload time, but it is not a folder.
 */

import { validateBackblazeCredentials } from "./b2-credentials.js";
import { uploadBytesViaS3 } from "./b2-s3-upload.js";
import { applyRequiredPrefix, sanitizePathSegment } from "./b2-path.js";

export { applyRequiredPrefix, sanitizePathSegment } from "./b2-path.js";

const AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";

let authCache = null;
let uploadCache = null;

export function clearB2UploadCaches() {
  authCache = null;
  uploadCache = null;
}

export function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatLocalStamp(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${formatLocalDate(date)}_${hours}${minutes}${seconds}`;
}

export function buildScreenshotObjectKey({
  prefix = "puma",
  profile = "upwork",
  downloadFolder = "",
  step = 1,
  trigger = "step",
  when = new Date()
} = {}) {
  const root = String(prefix || "puma").replace(/^\/+|\/+$/g, "") || "puma";
  const profileSlug = sanitizePathSegment(profile, "default");
  const slug = jobSlug(downloadFolder);
  const safeTrigger = String(trigger || "step").replace(/[^a-zA-Z0-9._-]+/g, "-") || "step";
  const day = formatLocalDate(when);
  const stamp = formatLocalStamp(when);
  return `${root}/${day}/${profileSlug}/${slug}/step${step}_${safeTrigger}_${stamp}.png`;
}

const TEST_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function uploadPngToB2({ settings, objectKey, dataUrl }) {
  try {
    const bytes = await dataUrlToBytes(dataUrl);
    const useNative = settings?.b2UploadApi === "native";

    if (!useNative) {
      const uploaded = await uploadBytesViaS3({
        settings,
        objectKey,
        bytes,
        contentType: "image/png"
      });
      return {
        ok: true,
        fileName: uploaded.fileName || objectKey,
        fileId: "",
        backend: "s3"
      };
    }

    const uploaded = await uploadBytes(settings, objectKey, bytes, "image/png");
    return {
      ok: true,
      fileName: uploaded.fileName || objectKey,
      fileId: uploaded.fileId || "",
      backend: "native"
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Backblaze upload failed"
    };
  }
}

export async function testBackblazeConnection(settings) {
  const creds = validateBackblazeCredentials(settings);
  if (!creds.ok) return { ok: false, error: creds.error };

  const prefix = String(settings?.b2KeyPrefix || "puma").replace(/^\/+|\/+$/g, "") || "puma";
  const profile = sanitizePathSegment(settings?.b2ProfileName, "default");
  const day = formatLocalDate(new Date());
  const stamp = formatLocalStamp(new Date());
  const objectKey = `${prefix}/${day}/${profile}/_bid_track_connection_test_${stamp}.png`;
  const dataUrl = `data:image/png;base64,${TEST_PNG}`;
  const result = await uploadPngToB2({ settings, objectKey, dataUrl });
  if (!result.ok) return result;
  return {
    ok: true,
    message: `Uploaded test file: ${result.fileName}`,
    backend: result.backend || "s3"
  };
}

async function uploadBytes(settings, objectKey, bytes, contentType) {
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      clearB2UploadCaches();
    }

    try {
      const auth = await getAuth(settings);
      const key = applyRequiredPrefix(objectKey, auth.namePrefix);
      const upload = await getUploadUrl(auth);

      const sha1 = await sha1Hex(bytes);
      const response = await fetch(upload.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: upload.authorizationToken,
          "X-Bz-File-Name": encodeB2FileName(key),
          "Content-Type": contentType,
          "X-Bz-Content-Sha1": sha1
        },
        body: bytes
      });

      if (response.ok) {
        uploadCache = null;
        return response.json();
      }

      const body = await response.json().catch(() => ({}));
      lastError = new Error(body.message || body.code || `Backblaze upload failed (${response.status})`);
      if (isAuthFailure(body.code, response.status)) {
        continue;
      }
      throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isAuthFailure(lastError.message, 0)) {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error("Backblaze upload failed");
}

function isAuthFailure(codeOrMessage, status) {
  const text = String(codeOrMessage || "").toLowerCase();
  if (status === 401 || status === 403) return true;
  return (
    text.includes("bad_auth_token") ||
    text.includes("expired_auth_token") ||
    text.includes("unauthorized") ||
    text.includes("auth token")
  );
}

function settingsAuthKey(settings) {
  return [
    settings?.b2KeyId || "",
    settings?.b2ApplicationKey || "",
    settings?.b2BucketName || "",
    settings?.b2BucketId || ""
  ].join("|");
}

async function getAuth(settings) {
  const authKey = settingsAuthKey(settings);
  if (authCache && authCache.authKey === authKey && authCache.expiresAt > Date.now()) {
    return authCache;
  }

  clearB2UploadCaches();

  const keyId = String(settings?.b2KeyId || "").trim();
  const applicationKey = String(settings?.b2ApplicationKey || "").trim();
  const bucketName = String(settings?.b2BucketName || "").trim();
  if (!bucketName) {
    throw new Error("Bucket name missing — open Bid Track Local Settings");
  }
  if (!keyId) {
    throw new Error("Key ID missing — open Bid Track Local Settings");
  }
  if (!applicationKey) {
    throw new Error("Application key missing — paste it in Settings and click Save");
  }

  const response = await fetch(AUTHORIZE_URL, {
    method: "GET",
    headers: { Authorization: basicAuthHeader(keyId, applicationKey) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.code || `Backblaze auth failed (${response.status})`);
  }

  const allowedName = body.allowed?.bucketName || "";
  if (allowedName && allowedName !== bucketName) {
    throw new Error(`This key can only write to bucket "${allowedName}"`);
  }

  const configuredBucketId = String(settings?.b2BucketId || "").trim();
  let bucketId = String(body.allowed?.bucketId || "").trim();
  if (!bucketId) {
    bucketId = configuredBucketId || (await findBucketId(body, bucketName));
  }
  if (!bucketId) {
    throw new Error("Bucket ID is required for this application key (add it in Settings)");
  }

  authCache = {
    authKey,
    authorizationToken: body.authorizationToken,
    apiUrl: body.apiUrl,
    accountId: body.accountId,
    bucketId,
    namePrefix: body.allowed?.namePrefix || settings?.b2KeyPrefix || "puma",
    expiresAt: Date.now() + 50 * 60 * 1000
  };
  return authCache;
}

async function findBucketId(auth, bucketName) {
  const response = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketName
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.code || `Could not find bucket "${bucketName}"`);
  }
  const match = (body.buckets || []).find((bucket) => bucket.bucketName === bucketName);
  if (!match?.bucketId) throw new Error(`Bucket "${bucketName}" was not found`);
  return match.bucketId;
}

async function getUploadUrl(auth) {
  uploadCache = null;

  const response = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ bucketId: auth.bucketId })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.code || `Could not get a Backblaze upload URL (${response.status})`);
  }

  uploadCache = {
    bucketId: auth.bucketId,
    uploadUrl: body.uploadUrl,
    authorizationToken: body.authorizationToken
  };
  return uploadCache;
}

function basicAuthHeader(keyId, applicationKey) {
  const raw = `${keyId}:${applicationKey}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function jobSlug(downloadFolder) {
  const last = String(downloadFolder || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop();
  const slug = String(last || "job")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "job";
}

function encodeB2FileName(name) {
  return encodeURIComponent(name).replace(/%2F/gi, "/");
}

async function dataUrlToBytes(dataUrl) {
  const response = await fetch(dataUrl);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
