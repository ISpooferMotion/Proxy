import { join } from "node:path";
import {
  installerName,
  platforms,
  releaseSigner,
  sha256File,
  signedRelease,
  sourceRepository,
  validateOrigin,
} from "./desktop-release.mjs";

const [stage, repository = sourceRepository, tag, version, apiBaseArg] =
  process.argv.slice(2);
if (!stage || !repository || !tag || !version) {
  throw new Error(
    "Usage: publish-runtime-updates.mjs <stage> <repository> <tag> <version> [api-origin]",
  );
}
if (repository !== sourceRepository)
  throw new Error("Release repository is not trusted");
if (tag !== `v${version}`) throw new Error("Version and release tag disagree");
const apiBase = validateOrigin(
  apiBaseArg || process.env.RELEASE_API_BASE || "https://ispoofermotion.com",
);
const privateKey = process.env.UPDATER_PRIVATE_KEY;
const apiToken = process.env.RELEASE_API_TOKEN;
if (!privateKey || !apiToken)
  throw new Error("UPDATER_PRIVATE_KEY and RELEASE_API_TOKEN are required");
const signer = releaseSigner(privateKey);
const releases = [];
for (const platform of platforms) {
  const name = installerName(version, platform);
  const hash = await sha256File(join(stage, name));
  const signedData = {
    os: platform.os,
    arch: platform.arch,
    version: tag,
    url: `${apiBase}/api/v3/proxy/update/download?os=${platform.os}&arch=${platform.arch}&version=${encodeURIComponent(tag)}`,
    sourceUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    hash,
  };
  releases.push(signedRelease(signedData, signer));
}

const response = await fetch(`${apiBase}/api/v3/updates/latest`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ releases }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.body)
  throw new Error("Metadata publication returned no response");
const reader = response.body.getReader();
const chunks = [];
let resultBytes = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  resultBytes += value.byteLength;
  if (resultBytes > 65_536) {
    await reader.cancel();
    throw new Error("Metadata publication response exceeded the size limit");
  }
  chunks.push(value);
}
const result = Buffer.concat(
  chunks.map((chunk) => Buffer.from(chunk)),
).toString("utf8");
if (!response.ok) {
  throw new Error(
    `Metadata publication failed: HTTP ${response.status}: ${result.slice(0, 500)}`,
  );
}
let parsed;
try {
  parsed = JSON.parse(result);
} catch {
  throw new Error("Invalid publication confirmation");
}
if (parsed.success !== true || parsed.count !== releases.length)
  throw new Error("Metadata publication was not confirmed");
console.log(
  `Published ${releases.length} signed desktop release manifests for ${tag}`,
);
