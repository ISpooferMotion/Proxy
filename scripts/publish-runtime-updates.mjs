import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import contract from "../release-contract.json" with { type: "json" };

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";

function validateApiBase(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Release API base must be a valid URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "ispoofermotion.com" && !host.endsWith(".ispoofermotion.com")) ||
    (parsed.port && parsed.port !== "443") ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Release API base must be an ispoofermotion.com HTTPS origin");
  }
  return parsed.origin;
}

async function hashArchive(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release archive must be a regular file: ${path}`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`Release archive is empty or exceeds the size limit: ${path}`);
  }
  const digest = createHash("sha256");
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    total += chunk.length;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error(`Release archive exceeded the size limit while reading: ${path}`);
    }
    digest.update(chunk);
  }
  if (total !== metadata.size) {
    throw new Error(`Release archive changed while it was being hashed: ${path}`);
  }
  return digest.digest("hex");
}

async function readResponseJsonBounded(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        await reader.cancel("response exceeds the size limit");
        throw new Error("Update metadata API response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

const [stage, repository, tag, version, apiBaseArg] = process.argv.slice(2);
const apiBaseValue = apiBaseArg || process.env.RELEASE_API_BASE || "";
const privateKeyValue = process.env.UPDATER_PRIVATE_KEY?.replace(/\\n/g, "\n");
const apiToken = process.env.RELEASE_API_TOKEN;
if (!stage || !repository || !tag || !version || !apiBaseValue) {
  throw new Error(
    "Usage: publish-runtime-updates.mjs <stage> <repository> <tag> <version> <api-base>",
  );
}
if (!privateKeyValue || !apiToken) {
  throw new Error("UPDATER_PRIVATE_KEY and RELEASE_API_TOKEN are required");
}

const privateKey = createPrivateKey(privateKeyValue);
const publicKeyHex = Buffer.from(
  createPublicKey(privateKey).export({ format: "der", type: "spki" }),
).toString("hex");
if (
  publicKeyHex !== `${ED25519_SPKI_PREFIX_HEX}${contract.releasePublicKeyHex}`
) {
  throw new Error(
    "UPDATER_PRIVATE_KEY does not match the public key embedded in released clients",
  );
}
const apiBase = validateApiBase(apiBaseValue);
const releases = [];
for (const platform of contract.platforms) {
  const asset = `ISpooferMotion-${platform.label}.zip`;
  const hash = await hashArchive(join(stage, asset));
  const url = `${apiBase}/api/v3/proxy/update/download?os=${platform.os}&arch=${platform.arch}&version=${encodeURIComponent(tag)}`;
  const sourceUrl = `https://github.com/${repository}/releases/download/${tag}/${asset}`;
  const signedData = { version: tag, url, hash };
  const payload = `ISM3\0update-manifest\0${JSON.stringify(signedData)}`;
  const signature = sign(null, Buffer.from(payload), privateKey).toString(
    "base64",
  );
  releases.push({
    os: platform.os,
    arch: platform.arch,
    ...signedData,
    source_url: sourceUrl,
    signature,
  });
}

const response = await fetch(`${apiBase}/api/v3/updates/latest`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ releases }),
  signal: AbortSignal.timeout(30_000),
});
const result = await readResponseJsonBounded(response);
if (!response.ok) {
  const message = result?.text.slice(0, 500) ?? "";
  throw new Error(
    `Update metadata publication failed (${response.status}): ${message}`,
  );
}
if (result?.json?.success !== true || result?.json?.count !== releases.length) {
  throw new Error("Update metadata API returned an invalid success response");
}
