import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import contract from "../release-contract.json" with { type: "json" };

const scripts = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), "ism-release-tools-"));
const artifacts = join(root, "artifacts");
const stage = join(root, "stage");
const version = "3.8.22";

function run(script, ...args) {
  execFileSync(process.execPath, [join(scripts, script), ...args], {
    stdio: "pipe",
  });
}

async function put(name, contents = name) {
  const target = join(artifacts, name.slice(0, 3), name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

try {
  for (const { label } of contract.platforms) {
    const asset = `ISpooferMotion-${label}.zip`;
    const contents = Buffer.from(`runtime:${label}`);
    const digest = createHash("sha256").update(contents).digest("hex");
    await put(asset, contents);
    await put(`${asset}.sha256`, `${digest}  ${asset}\n`);
    await put(`ISpooferMotion-${label}.sbom.cdx.json`, "{}\n");
  }

  const loaderPrefix = `ISpooferMotion-Loader-${version}`;
  const loaderAssets = [
    `${loaderPrefix}-windows-x86_64-setup.exe`,
    `${loaderPrefix}-macos-x86_64.dmg`,
    `${loaderPrefix}-macos-x86_64.app.tar.gz`,
    `${loaderPrefix}-macos-aarch64.dmg`,
    `${loaderPrefix}-macos-aarch64.app.tar.gz`,
    `${loaderPrefix}-linux-x86_64.AppImage`,
  ];
  for (const asset of loaderAssets) await put(asset);
  for (const asset of loaderAssets.filter((name) => !name.endsWith(".dmg"))) {
    await put(`${asset}.sig`, Buffer.alloc(64, 7).toString("base64"));
  }
  for (const label of contract.platforms.map(({ label }) => label)) {
    await put(`${loaderPrefix}-${label}.sbom.cdx.json`, "{}\n");
  }

  run("stage-release-assets.mjs", artifacts, stage, version);
  run(
    "generate-loader-manifest.mjs",
    stage,
    "ISpooferMotion/ISpooferMotion-VeeThree",
    version,
    version,
  );

  const manifest = JSON.parse(await readFile(join(stage, "latest.json")));
  if (
    manifest.version !== version ||
    Object.keys(manifest.platforms).length !== 4
  ) {
    throw new Error("Loader manifest did not preserve the release contract");
  }
  const staged = await readdir(stage);
  if (!staged.includes("SHA256SUMS") || !staged.includes("latest.json")) {
    throw new Error("Release staging omitted generated metadata");
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const publicBytes = Buffer.from(
    publicKey.export({ format: "jwk" }).x,
    "base64url",
  );
  const publicRecord = Buffer.concat([Buffer.from("Ed"), keyId, publicBytes]);
  const publicText = `untrusted comment: test public key\n${publicRecord.toString("base64")}\n`;
  const encodedPublic = Buffer.from(publicText).toString("base64");
  const signedArtifact = join(root, "signed.bin");
  const signaturePath = `${signedArtifact}.sig`;
  const bytes = Buffer.from("signed updater artifact");
  await writeFile(signedArtifact, bytes);
  const signature = sign(
    null,
    createHash("blake2b512").update(bytes).digest(),
    privateKey,
  );
  const signatureRecord = Buffer.concat([Buffer.from("ED"), keyId, signature]);
  const signatureText = `untrusted comment: test signature\n${signatureRecord.toString("base64")}\n`;
  await writeFile(signaturePath, Buffer.from(signatureText).toString("base64"));
  run(
    "verify-tauri-signature.mjs",
    signedArtifact,
    signaturePath,
    encodedPublic,
  );

  await writeFile(signedArtifact, "tampered updater artifact");
  let rejected = false;
  try {
    run(
      "verify-tauri-signature.mjs",
      signedArtifact,
      signaturePath,
      encodedPublic,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Tampered updater artifact was accepted");

  console.log("Release tool validation passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
