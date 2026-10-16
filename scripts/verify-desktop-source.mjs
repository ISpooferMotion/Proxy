import { verifyDesktopSource } from "./desktop-release.mjs";
const [sourcePath, tag] = process.argv.slice(2);
if (!sourcePath)
  throw new Error(
    "Usage: verify-desktop-source.mjs <source-path> [release-tag]",
  );
console.log(
  `Desktop source validated: ${await verifyDesktopSource(sourcePath, tag)}`,
);
