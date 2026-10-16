import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { installerName, platforms, sha256File } from "./desktop-release.mjs";

const [bundleDirectory, stageDirectory, version, label] = process.argv.slice(2);
const platform = platforms.find((value) => value.label === label);
if (!bundleDirectory || !stageDirectory || !version || !platform) {
  throw new Error(
    "Usage: stage-desktop-installer.mjs <bundle-dir> <stage-dir> <version> <platform-label>",
  );
}
const candidates = (
  await readdir(bundleDirectory, { withFileTypes: true })
).filter((entry) => entry.isFile() && entry.name.endsWith(platform.extension));
if (candidates.length !== 1) {
  throw new Error(
    `Expected one ${platform.extension} installer, found ${candidates.length}`,
  );
}
await mkdir(stageDirectory, { recursive: true });
const filename = installerName(version, platform);
const source = join(bundleDirectory, candidates[0].name);
const target = join(stageDirectory, filename);
await sha256File(source);
await cp(source, target, { force: false, errorOnExist: true });
console.log(`${filename}: ${await sha256File(target)}`);
