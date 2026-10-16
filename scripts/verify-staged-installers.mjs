import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { installerName, platforms, sha256File } from "./desktop-release.mjs";
const [stage, version] = process.argv.slice(2);
if (!stage || !version)
  throw new Error("Usage: verify-staged-installers.mjs <stage> <version>");
const expected = platforms
  .map((platform) => installerName(version, platform))
  .sort();
const found = (await readdir(stage)).sort();
if (JSON.stringify(expected) !== JSON.stringify(found))
  throw new Error(
    `Installer inventory mismatch: expected ${expected}, got ${found}`,
  );
for (const name of expected)
  console.log(`${name}: ${await sha256File(join(stage, name))}`);
