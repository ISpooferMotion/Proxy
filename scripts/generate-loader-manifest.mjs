import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [stage, repository, tag, version] = process.argv.slice(2);
if (!stage || !repository || !tag || !version) {
  throw new Error(
    "Usage: generate-loader-manifest.mjs <stage> <repository> <tag> <version>",
  );
}

const prefix = `ISpooferMotion-Loader-${version}`;
const platforms = {
  "windows-x86_64": `${prefix}-windows-x86_64-setup.exe`,
  "darwin-x86_64": `${prefix}-macos-x86_64.app.tar.gz`,
  "darwin-aarch64": `${prefix}-macos-aarch64.app.tar.gz`,
  "linux-x86_64": `${prefix}-linux-x86_64.AppImage`,
};

const entries = {};
for (const [platform, asset] of Object.entries(platforms)) {
  const signature = (
    await readFile(join(stage, `${asset}.sig`), "utf8")
  ).trim();
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(signature) || signature.length < 40) {
    throw new Error(`Invalid updater signature for ${asset}`);
  }
  entries[platform] = {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(basename(asset))}`,
  };
}

const manifest = `${JSON.stringify({ version, notes: `ISpooferMotion ${version}`, platforms: entries }, null, 2)}\n`;
await writeFile(join(stage, "latest.json"), manifest);
const digest = createHash("sha256").update(manifest).digest("hex");
await appendFile(join(stage, "SHA256SUMS"), `${digest}  latest.json\n`);
