import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [artifactsDirArg, stageDirArg] = process.argv.slice(2);
const artifactsDir = artifactsDirArg || "artifacts";
const stageDir = stageDirArg || "test-builds";

async function walk(dir) {
  const files = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(fullPath)));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch {}
  return files;
}

async function sha256(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  await mkdir(stageDir, { recursive: true });

  const allFiles = await walk(artifactsDir);

  // Stage runtime zips
  for (const file of allFiles) {
    const name = basename(file);
    if (name.startsWith("ISpooferMotion-") && name.endsWith(".zip")) {
      console.log(`Staging runtime zip: ${name}`);
      await cp(file, join(stageDir, name));
    }
  }

  // Stage loader installers (.exe setup and .dmg)
  for (const file of allFiles) {
    const name = basename(file);
    if (name.endsWith("-setup.exe") || name.endsWith(".dmg")) {
      console.log(`Staging loader installer: ${name}`);
      await cp(file, join(stageDir, name));
    }
  }

  const stagedFiles = (await readdir(stageDir)).filter((n) => !n.startsWith("."));
  if (stagedFiles.length === 0) {
    throw new Error(`No files found to stage from ${artifactsDir}`);
  }

  // Preserve checksums for manually downloaded build artifacts.
  const checksums = [];

  for (const name of stagedFiles.sort()) {
    const filePath = join(stageDir, name);
    const hash = await sha256(filePath);
    checksums.push(`${hash}  ${name}`);
  }

  await writeFile(join(stageDir, "SHA256SUMS"), `${checksums.join("\n")}\n`);

  console.log(`Successfully staged ${stagedFiles.length} artifacts in ${stageDir}:`);
  for (const row of checksums) {
    console.log(`  ${row}`);
  }
}

main().catch((err) => {
  console.error("Failed to stage test builds:", err);
  process.exit(1);
});
