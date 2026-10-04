import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import contract from "../release-contract.json" with { type: "json" };

const uiDirectory = resolve(process.argv[2] ?? "source/apps/ui");
const packageJson = JSON.parse(
  await readFile(resolve(uiDirectory, "package.json"), "utf8"),
);
const dependency = packageJson.dependencies?.["@ispoofermotion/core"];

if (dependency !== contract.corePackageUrl) {
  throw new Error(
    `UI Core dependency ${JSON.stringify(dependency)} does not match release contract ${JSON.stringify(contract.corePackageUrl)}`,
  );
}
if (!contract.corePackageUrl.includes(`/v${contract.coreVersion}/`)) {
  throw new Error("Core package URL does not match the contracted Core version");
}

const response = await fetch(contract.corePackageUrl, { redirect: "follow" });
if (!response.ok) {
  throw new Error(`Core package download failed with HTTP ${response.status}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== contract.corePackageSha256) {
  throw new Error(
    `Core package SHA-256 mismatch: expected ${contract.corePackageSha256}, received ${sha256}`,
  );
}

const lock = await readFile(resolve(uiDirectory, "bun.lock"), "utf8");
const sha512 = createHash("sha512").update(bytes).digest("base64");
if (!lock.includes(contract.corePackageUrl) || !lock.includes(`sha512-${sha512}`)) {
  throw new Error("UI lockfile does not pin the contracted Core package and integrity");
}

console.log(
  `Verified @ispoofermotion/core ${contract.coreVersion} (${sha256})`,
);
