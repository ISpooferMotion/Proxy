import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import contract from "../release-contract.json" with { type: "json" };

const [artifacts, stage, version] = process.argv.slice(2);
if (!artifacts || !stage || !version) {
  throw new Error(
    "Usage: stage-release-assets.mjs <artifacts> <stage> <version>",
  );
}

async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

const expected = new Set();
for (const { label } of contract.platforms) {
  expected.add(`ISpooferMotion-${label}.zip`);
  expected.add(`ISpooferMotion-${label}.zip.sha256`);
  expected.add(`ISpooferMotion-${label}.sbom.cdx.json`);
}
const loaderPrefix = `ISpooferMotion-Loader-${version}`;
for (const name of [
  `${loaderPrefix}-windows-x86_64-setup.exe`,
  `${loaderPrefix}-windows-x86_64-setup.exe.sig`,
  `${loaderPrefix}-windows-x86_64.sbom.cdx.json`,
  `${loaderPrefix}-macos-x86_64.dmg`,
  `${loaderPrefix}-macos-x86_64.app.tar.gz`,
  `${loaderPrefix}-macos-x86_64.app.tar.gz.sig`,
  `${loaderPrefix}-macos-x86_64.sbom.cdx.json`,
  `${loaderPrefix}-macos-aarch64.dmg`,
  `${loaderPrefix}-macos-aarch64.app.tar.gz`,
  `${loaderPrefix}-macos-aarch64.app.tar.gz.sig`,
  `${loaderPrefix}-macos-aarch64.sbom.cdx.json`,
])
  expected.add(name);

const files = await walk(artifacts);
const byName = new Map();
for (const file of files) {
  const name = basename(file);
  if (!expected.has(name)) continue;
  if (byName.has(name)) throw new Error(`Duplicate release asset: ${name}`);
  byName.set(name, file);
}
const missing = [...expected].filter((name) => !byName.has(name));
if (missing.length)
  throw new Error(`Missing release assets: ${missing.join(", ")}`);

await mkdir(stage, { recursive: true });
for (const [name, source] of byName) await cp(source, join(stage, name));

for (const { label } of contract.platforms) {
  const asset = `ISpooferMotion-${label}.zip`;
  const digest = createHash("sha256")
    .update(await readFile(join(stage, asset)))
    .digest("hex");
  const declared = (
    await readFile(join(stage, `${asset}.sha256`), "utf8")
  ).trim();
  if (declared !== `${digest}  ${asset}`) {
    throw new Error(`Checksum mismatch for ${asset}`);
  }
}

const checksumLines = [];
for (const name of [...expected]
  .filter((name) => !name.endsWith(".sha256"))
  .sort()) {
  const digest = createHash("sha256")
    .update(await readFile(join(stage, name)))
    .digest("hex");
  checksumLines.push(`${digest}  ${name}`);
}
await writeFile(join(stage, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
