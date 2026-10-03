import { AwsClient } from "./aws4fetch.mjs";
import { validateBackblazeCredentials } from "./b2-credentials.js";
import { applyRequiredPrefix } from "./b2-path.js";

/**
 * Backblaze S3-compatible PUT (SigV4 via aws4fetch).
 * @see https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api
 */
export async function uploadBytesViaS3({ settings, objectKey, bytes, contentType }) {
  const creds = validateBackblazeCredentials(settings);
  if (!creds.ok) {
    throw new Error(creds.error);
  }

  const region = String(settings?.b2S3Region || "us-east-005").trim();
  const bucket = String(settings?.b2BucketName || "").trim();
  const keyId = creds.b2KeyId;
  const secretKey = creds.b2ApplicationKey;

  if (!bucket) {
    throw new Error("Bucket name missing — open Bid Track Local Settings");
  }

  const objectKeyPath = applyRequiredPrefix(objectKey, settings?.b2KeyPrefix || "puma");
  const baseHost = resolveS3BaseHost(settings?.b2S3Endpoint, region);
  const host = `${bucket}.${baseHost}`;
  const url = `https://${host}/${encodeObjectKeyPath(objectKeyPath)}`;

  const client = new AwsClient({
    accessKeyId: keyId,
    secretAccessKey: secretKey,
    region,
    service: "s3",
    retries: 0
  });

  const response = await client.fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes
  });

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 280);
    if (response.status === 403 && /SignatureDoesNotMatch|signature/i.test(detail)) {
      throw new Error(
        "S3 signature rejected — create a new application key in Backblaze, paste Key ID (005…) and secret (K005…) in Settings, Save, then Test upload"
      );
    }
    throw new Error(detail || `S3 upload failed (${response.status})`);
  }

  return { fileName: objectKeyPath };
}

function resolveS3BaseHost(endpoint, region) {
  const raw = String(endpoint || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (raw && /^s3\.[^.]+\.backblazeb2\.com$/i.test(raw)) {
    return raw.toLowerCase();
  }
  return `s3.${region}.backblazeb2.com`;
}

function encodeObjectKeyPath(path) {
  return String(path || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
