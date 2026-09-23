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
const version = "3.2609.22";

async function assertReleaseContractPins() {
  if (
    contract.coreRef !== "3bdf354ed3c1d85e09e3c9c8f320e684dad02d27" ||
    contract.coreVersion !== "4.2.0" ||
    !/^[a-f0-9]{64}$/.test(contract.releasePublicKeyHex)
  ) {
    throw new Error("Release contract pins are invalid");
  }
  const workflowFiles = [
    ".github/actions/setup-build/action.yml",
    ".github/workflows/build-daemon.yml",
    ".github/workflows/build-loader.yml",
    ".github/workflows/build-mcp-server.yml",
    ".github/workflows/build-studio-payload.yml",
    ".github/workflows/build-ui.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/obfuscator-stress.yml",
    ".github/workflows/package-runtime.yml",
    ".github/workflows/release.yml",
  ];
  const workflows = (
    await Promise.all(
      workflowFiles.map((path) => readFile(join(scripts, "..", path), "utf8")),
    )
  ).join("\n");
  for (const stale of [
    "1.97.1",
    "bun-version: 1.3.14",
    "ispoofermotion-core-4.1.1.tgz",
    "repository: ISpooferMotion/Core",
    "package:pack",
    "file:../../../Core/",
    "scripts/test/",
  ]) {
    if (workflows.includes(stale)) {
      throw new Error(`Release workflows contain stale pin: ${stale}`);
    }
  }
  for (const required of [
    "1.98.1",
    "bun-version: 1.4.2",
    "bun test scripts/tests",
  ]) {
    if (!workflows.includes(required)) {
      throw new Error(`Release workflows are missing current pin: ${required}`);
    }
  }
  const sourceCheckoutCount =
    workflows.match(/^\s+path: source\s*$/gm)?.length ?? 0;
  const privateRepositoryCount =
    workflows.match(
      /^\s+repository: ISpooferMotion\/ISpooferMotion-VeeThree\s*$/gm,
    )?.length ?? 0;
  const privateTokenCount =
    workflows.match(/^\s+token: \$\{\{ secrets\.PAT \}\}\s*$/gm)?.length ?? 0;
  if (
    sourceCheckoutCount === 0 ||
    privateRepositoryCount !== sourceCheckoutCount ||
    privateTokenCount !== sourceCheckoutCount
  ) {
    throw new Error(
      "Every source checkout must read the private V3 repository with PAT",
    );
  }
  for (const dispatchable of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    const contents = await readFile(join(scripts, "..", dispatchable), "utf8");
    if (!contents.includes("workflow_dispatch:")) {
      throw new Error(`${dispatchable} cannot run from the public Proxy repository`);
    }
  }
  const releaseWorkflow = await readFile(
    join(scripts, "..", ".github/workflows/release.yml"),
    "utf8",
  );
  if (
    !releaseWorkflow.includes('--target "$GITHUB_SHA"') ||
    releaseWorkflow.includes('--target "$SOURCE_SHA"')
  ) {
    throw new Error("Public Proxy releases must target the Proxy workflow commit");
  }
  const workflowLines = workflows.split(/\r?\n/);
  for (let index = 0; index < workflowLines.length; index += 1) {
    const line = workflowLines[index];
    if (line.includes("import-windows-certificate")) {
      const guard = workflowLines[index - 1] ?? "";
      if (
        !guard.includes("if:") ||
        !guard.includes("env.WINDOWS_SIGNING_ENABLED == 'true'")
      ) {
        throw new Error("Windows certificate import is not optional");
      }
    }
    if (line.includes("import-apple-certificate")) {
      const guard = workflowLines[index - 1] ?? "";
      if (
        !guard.includes("if:") ||
        !guard.includes("env.APPLE_SIGNING_ENABLED == 'true'")
      ) {
        throw new Error("Apple certificate import is not optional");
      }
    }
  }
  for (const required of [
    "WINDOWS_SIGNING_ENABLED: ${{ secrets.WINDOWS_CERTIFICATE_BASE64 != '' && secrets.WINDOWS_CERTIFICATE_PASSWORD != '' }}",
    "APPLE_SIGNING_ENABLED: ${{ secrets.APPLE_CERTIFICATE != '' && secrets.APPLE_CERTIFICATE_PASSWORD != '' && secrets.APPLE_SIGNING_IDENTITY != '' }}",
  ]) {
    if (!workflows.includes(required)) {
      throw new Error(`Optional signing presence check is missing: ${required}`);
    }
  }
  const loaderWorkflow = await readFile(
    join(scripts, "..", ".github/workflows/build-loader.yml"),
    "utf8",
  );
  for (const required of [
    "process.env.WINDOWS_CERTIFICATE_THUMBPRINT",
    "IsNullOrWhiteSpace($env:SIGNTOOL)",
    "APPLE_SIGNING_ENABLED",
    "APPLE_NOTARIZATION_ENABLED",
  ]) {
    if (!loaderWorkflow.includes(required)) {
      throw new Error(`Loader optional signing guard is missing: ${required}`);
    }
  }
  if (loaderWorkflow.includes("Windows certificate thumbprint is required")) {
    throw new Error("Unsigned Windows Loader builds are still blocked");
  }
  const obfuscatorWorkflow = await readFile(
    join(scripts, "..", ".github/workflows/obfuscator-stress.yml"),
    "utf8",
  );
  for (const required of [
    "Verify complete path-scrambled workspace",
    "bun scripts/obfuscate.ts",
    "--profile hardened",
    "runs-on: windows-latest",
    "--target \"${{ runner.temp }}\\ism-path-scramble\"",
    "--ts",
    "Verify every path-scrambled Rust target",
    "cargo check --locked --workspace --all-targets --all-features",
  ]) {
    if (!obfuscatorWorkflow.includes(required)) {
      throw new Error(`Obfuscator path-scramble gate is missing: ${required}`);
    }
  }
  const publisher = await readFile(
    join(scripts, "publish-runtime-updates.mjs"),
    "utf8",
  );
  for (const required of [
    "releasePublicKeyHex",
    "MAX_ARCHIVE_BYTES",
    "MAX_API_RESPONSE_BYTES",
    "ispoofermotion.com HTTPS origin",
  ]) {
    if (!publisher.includes(required)) {
      throw new Error(`Runtime publisher is missing safety contract: ${required}`);
    }
  }
  const runtimeWorkflow = await readFile(
    join(scripts, "..", ".github/workflows/package-runtime.yml"),
    "utf8",
  );
  if (
    runtimeWorkflow.includes("pattern: component-mcp-server-*") ||
    !runtimeWorkflow.includes("name: component-mcp-server-${{ matrix.label }}")
  ) {
    throw new Error("Runtime packaging does not select the architecture-specific MCP artifact");
  }
}

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
  await assertReleaseContractPins();
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
  const manifestPlatforms = Object.keys(manifest.platforms).sort();
  const expectedPlatforms = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
  ];
  if (
    manifest.version !== version ||
    JSON.stringify(manifestPlatforms) !== JSON.stringify(expectedPlatforms)
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
