import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import contract from "../release-contract.json" with { type: "json" };

const [stage, repository, tag, version, apiBaseArg] = process.argv.slice(2);
const apiBase = (apiBaseArg || process.env.RELEASE_API_BASE || "").replace(
  /\/$/,
  "",
);
const privateKeyValue = process.env.UPDATER_PRIVATE_KEY?.replace(/\\n/g, "\n");
const apiToken = process.env.RELEASE_API_TOKEN;
if (!stage || !repository || !tag || !version || !apiBase) {
  throw new Error(
    "Usage: publish-runtime-updates.mjs <stage> <repository> <tag> <version> <api-base>",
  );
}
if (!privateKeyValue || !apiToken) {
  throw new Error("UPDATER_PRIVATE_KEY and RELEASE_API_TOKEN are required");
}

const privateKey = createPrivateKey(privateKeyValue);
const releases = [];
for (const platform of contract.platforms) {
  const asset = `ISpooferMotion-${platform.label}.zip`;
  const bytes = await readFile(join(stage, asset));
  const hash = createHash("sha256").update(bytes).digest("hex");
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
if (!response.ok) {
  const message = (await response.text()).slice(0, 500);
  throw new Error(
    `Update metadata publication failed (${response.status}): ${message}`,
  );
}
const result = await response.json();
if (result?.success !== true || result?.count !== releases.length) {
  throw new Error("Update metadata API returned an invalid success response");
}
