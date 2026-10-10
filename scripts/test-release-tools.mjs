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
    contract.coreRef !== "7a765a6f9d4754bf1dfc1640de6f9566b098d441" ||
    contract.coreVersion !== "4.3.0" ||
    contract.corePackageUrl !==
      "https://github.com/ISpooferMotion/Core/releases/download/v4.3.0/package.tgz" ||
    contract.corePackageSha256 !==
      "f3c28495ba663c2d732d107c2caecb8b0329b5eb5fdf5d4b043070c1707cb72a" ||
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
    !releaseWorkflow.includes('--target "$SOURCE_SHA"') ||
    releaseWorkflow.includes('--target "$GITHUB_SHA"')
  ) {
    throw new Error("Product releases must target the contracted source commit");
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
    "source_url: signedData.sourceUrl",
  ]) {
    if (!publisher.includes(required)) {
      throw new Error(`Runtime publisher is missing safety contract: ${required}`);
    }
  }
  if (/releases\.push\(\{[\s\S]*?\.\.\.signedData/.test(publisher)) {
    throw new Error(
      "Runtime publisher must not send signedData directly; the release API only accepts source_url on POST",
    );
  }
  const coreVerifier = await readFile(
    join(scripts, "verify-core-package.mjs"),
    "utf8",
  );
  for (const required of [
    "corePackageUrl",
    "corePackageSha256",
    "@ispoofermotion/core",
    "sha512-",
  ]) {
    if (!coreVerifier.includes(required)) {
      throw new Error(`Core package verifier is missing contract check: ${required}`);
    }
  }
  if (!workflows.includes("verify-core-package.mjs")) {
    throw new Error("Release workflows do not verify the pinned Core package");
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

  // Test builds publish finished packages to the private source repository,
  // never as downloadable artifacts on the public automation repository.
  const testWorkflow = await readFile(
    join(scripts, "..", ".github/workflows/test-builds.yml"),
    "utf8",
  );
  if (
    !testWorkflow.includes("workflow_dispatch:") ||
    !testWorkflow.includes("uses: ISpooferMotion/Proxy/.github/workflows/package-runtime.yml@main") ||
    !testWorkflow.includes("uses: ISpooferMotion/Proxy/.github/workflows/build-loader.yml@main") ||
    !testWorkflow.includes('repository="ISpooferMotion/ISpooferMotion-VeeThree"') ||
    !testWorkflow.includes('tag="test-build-${SHORT_SHA}"') ||
    !testWorkflow.includes('gh release upload "$tag" test-builds/*') ||
    !testWorkflow.includes("--draft") ||
    !testWorkflow.includes("--prerelease") ||
    /actions\/upload-artifact|retention-days:/i.test(testWorkflow) ||
    testWorkflow.includes("BUILD_INFO.md") ||
    /(?:discord(?:app)?\.com\/api|DISCORD_WEBHOOK|publish-runtime-updates\.mjs)/i.test(testWorkflow)
  ) {
    throw new Error("Test builds must publish only to a private V3 draft release");
  }
  const testCallCount = testWorkflow.match(/^      create_deployment: false$/gm)?.length ?? 0;
  if (testCallCount !== 5) {
    throw new Error("All five reusable test build calls must disable deployments");
  }
  if ((testWorkflow.match(/^      test_build: true$/gm)?.length ?? 0) !== 5) {
    throw new Error("All five test jobs must compile with the offline test build flag");
  }
  for (const file of ["build-daemon.yml", "build-ui.yml", "build-mcp-server.yml", "build-loader.yml", "build-studio-payload.yml"]) {
    const content = await readFile(join(scripts, "..", ".github/workflows", file), "utf8");
    if (!content.includes("ISM_PACKAGED_TEST_BUILD: ${{ inputs.test_build && '1' || '0' }}")) {
      throw new Error(`${file} must use a compile-time test flag`);
    }
  }
  const testStager = await readFile(join(scripts, "stage-test-builds.mjs"), "utf8");
  if (/BUILD_INFO\.md|writeFile\([^)]*\.md/i.test(testStager)) {
    throw new Error("Test staging must not generate Markdown build reports");
  }

  const cleanupWorkflow = await readFile(
    join(scripts, "..", ".github/workflows/purge-build-records.yml"),
    "utf8",
  );
  for (const required of [
    "workflow_run:",
    "ISpooferMotion Test Builds",
    "ISpooferMotion Release",
    "ISpooferMotion CI",
    "Obfuscator Stress",
    "actions: write",
    "/actions/artifacts/${artifact_id}",
    "/actions/runs/${TARGET_RUN_ID}",
    "purge-build-records.yml/runs?status=completed",
  ]) {
    if (!cleanupWorkflow.includes(required)) {
      throw new Error(`Build-record cleanup is missing: ${required}`);
    }
  }
  for (const file of [
    "build-daemon.yml",
    "build-ui.yml",
    "build-mcp-server.yml",
    "build-loader.yml",
    "build-studio-payload.yml",
  ]) {
    const contents = await readFile(join(scripts, "..", ".github/workflows", file), "utf8");
    if (
      !contents.includes("      create_deployment:") ||
      !contents.includes("        default: true") ||
      !contents.includes("      deployment: ${{ inputs.create_deployment }}")
    ) {
      throw new Error(`${file} must preserve deployments for release builds and disable them for tests`);
    }
    if (!contents.includes("retention-days: 1")) {
      throw new Error(`${file} must use the minimum fallback artifact retention`);
    }
  }
  if (!runtimeWorkflow.includes("retention-days: 1")) {
    throw new Error("Runtime packages must use the minimum fallback artifact retention");
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
    const isWindows = label === "windows-x86_64";
    const components = isWindows
      ? ["daemon.exe", "ui.exe", "mcp-server.exe", "ISpooferMotion.dll"]
      : ["daemon", "ui", "mcp-server", "libISpooferMotion.dylib"];
    const runtimePath = join(artifacts, asset.slice(0, 3), asset);
    await mkdir(dirname(runtimePath), { recursive: true });
    execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    for component in sys.argv[2:]:
        archive.writestr(component, (component + ':fixture').encode('utf8'))
`, runtimePath, ...components]);
    const digest = createHash("sha256").update(await readFile(runtimePath)).digest("hex");
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
  await put(`${loaderPrefix}-windows-x86_64.exe`, "signed-portable-loader");
  for (const asset of loaderAssets.filter((name) => !name.endsWith(".dmg"))) {
    await put(`${asset}.sig`, Buffer.alloc(64, 7).toString("base64"));
  }
  for (const label of contract.platforms.map(({ label }) => label)) {
    await put(`${loaderPrefix}-${label}.sbom.cdx.json`, "{}\n");
  }

  const testStage = join(root, "test-builds");
  run("stage-test-builds.mjs", artifacts, testStage, version);
  const testFiles = await readdir(testStage);
  const expectedTestFiles = [
    ...contract.platforms.map(({ label }) => `ISpooferMotion-${version}-${label}-test.zip`),
    "SHA256SUMS",
  ].sort();
  if (JSON.stringify(testFiles.sort()) !== JSON.stringify(expectedTestFiles)) {
    throw new Error(`Test stage must contain only manual build artifacts and checksums: ${testFiles}`);
  }
  if (testFiles.some((name) => name.toLowerCase().endsWith(".md"))) {
    throw new Error("Test stage unexpectedly contains a Markdown file");
  }
  // Verify the exact portable layout, integrity hashes, and paired version markers.
  for (const { label } of contract.platforms) {
    const output = join(testStage, `ISpooferMotion-${version}-${label}-test.zip`);
    const layout = JSON.parse(execFileSync("python3", ["-c", `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    manifest = json.loads(archive.read('bin/.ispoofermotion-install-integrity.json'))
    print(json.dumps({'names': names, 'manifest': manifest,
       'digest_ok': all(hashlib.sha256(archive.read('bin/' + name)).hexdigest() == h
                       for name, h in manifest['components'].items()),
       'daemon_version': archive.read('bin/.ispoofermotion-daemon-version').decode().strip(),
       'ui_version': archive.read('bin/.ispoofermotion-ui-version').decode().strip()}))
`, output], { encoding: "utf8" }));
    if (layout.manifest.version !== version || !layout.digest_ok ||
        layout.daemon_version !== version || layout.ui_version !== version) {
      throw new Error(`Invalid offline integrity contract: ${label}`);
    }
    const names = new Set(layout.names);
    const loaderName = label === "windows-x86_64"
      ? "ISpooferMotion.exe"
      : `${loaderPrefix}-${label}.dmg`;
    if (!names.has(loaderName) || !names.has("bin/.ispoofermotion-install-integrity.json") ||
        names.size !== (label === "windows-x86_64" ? 8 : 9)) {
      throw new Error(`Invalid portable test archive layout: ${label}`);
    }
    if (label !== "windows-x86_64" && !names.has("INSTALL-MACOS.txt")) {
      throw new Error(`macOS test bundle is missing offline installation instructions: ${label}`);
    }
  }

  for (const line of (await readFile(join(testStage, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !testFiles.includes(match[2])) {
      throw new Error(`Malformed test-stage checksum: ${line}`);
    }
    const digest = createHash("sha256").update(await readFile(join(testStage, match[2]))).digest("hex");
    if (digest !== match[1]) throw new Error(`Test-stage checksum mismatch: ${match[2]}`);
  }

  // A valid checksum is not sufficient if the runtime archive has extra or unsafe entries.
  const sampleLabel = "windows-x86_64";
  const sampleName = `ISpooferMotion-${sampleLabel}.zip`;
  const samplePath = join(artifacts, sampleName.slice(0, 3), sampleName);
  const checksumPath = join(artifacts, `${sampleName}.sha256`.slice(0, 3), `${sampleName}.sha256`);
  const originalRuntime = await readFile(samplePath);
  const originalChecksum = await readFile(checksumPath);
  const failureStage = join(root, "rejected-test-builds");
  try {
    await writeFile(checksumPath, `${"0".repeat(64)}  ${sampleName}\n`);
    let rejected = false;
    try { run("stage-test-builds.mjs", artifacts, failureStage, version); }
    catch { rejected = true; }
    if (!rejected) throw new Error("Test packages accepted a tampered runtime checksum");

    await writeFile(checksumPath, originalChecksum);
    execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('../escaped-file.exe', b'untrusted')
`, samplePath]);
    const maliciousDigest = createHash("sha256").update(await readFile(samplePath)).digest("hex");
    await writeFile(checksumPath, `${maliciousDigest}  ${sampleName}\n`);
    rejected = false;
    try { run("stage-test-builds.mjs", artifacts, failureStage, version); }
    catch { rejected = true; }
    if (!rejected) throw new Error("Test packages accepted an unsafe ZIP member");
  } finally {
    await writeFile(samplePath, originalRuntime);
    await writeFile(checksumPath, originalChecksum);
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
