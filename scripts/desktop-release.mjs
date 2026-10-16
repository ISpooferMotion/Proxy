import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import contract from "../release-contract.json" with { type: "json" };

const PUBLIC_KEY_PREFIX = "302a300506032b6570032100";
export const platforms = contract.platforms;
export const sourceRepository = contract.sourceRepository;

export function validateVersion(value) {
  if (!/^3\.\d{4}\.([1-9]|[12]\d|3[01])$/.test(value))
    throw new Error("Expected 3.YYMM.D CalVer");
  const [, ym, d] = /^3\.(\d{4})\.(\d+)$/.exec(value);
  const year = 2000 + Number(ym.slice(0, 2));
  const month = Number(ym.slice(2));
  const day = Number(d);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2024 || month < 1 || month > 12 || day > lastDay)
    throw new Error("Invalid release date");
  return value;
}

export function installerName(version, platform) {
  validateVersion(version);
  if (!platforms.some((item) => item.label === platform.label))
    throw new Error("Unknown build platform");
  return `ISpooferMotion-${version}-${platform.label}${platform.extension}`;
}

export function validateOrigin(value) {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "ispoofermotion.com" && !host.endsWith(".ispoofermotion.com")) ||
    (parsed.port && parsed.port !== "443") ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "Release API base must be an ispoofermotion.com HTTPS origin",
    );
  }
  return parsed.origin;
}

export function releaseSigner(privateKeyPem) {
  const key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  const publicHex = Buffer.from(
    createPublicKey(key).export({ format: "der", type: "spki" }),
  ).toString("hex");
  if (publicHex !== PUBLIC_KEY_PREFIX + contract.releasePublicKeyHex) {
    throw new Error(
      "UPDATER_PRIVATE_KEY does not match the public key embedded in ISpooferMotion",
    );
  }
  return key;
}

export function signedRelease(data, privateKey) {
  const signature = sign(
    null,
    Buffer.from(`ISM3\0update-manifest\0${JSON.stringify(data)}`),
    privateKey,
  ).toString("base64");
  return {
    os: data.os,
    arch: data.arch,
    version: data.version,
    url: data.url,
    source_url: data.sourceUrl,
    hash: data.hash,
    signature,
  };
}

export async function sha256File(path) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0 ||
    stat.size > 1024 ** 3
  ) {
    throw new Error(`Invalid desktop installer: ${path}`);
  }
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    total += chunk.length;
    hash.update(chunk);
  }
  if (total !== stat.size) throw new Error("Installer changed while hashing");
  return hash.digest("hex");
}

export async function verifyDesktopSource(path, expectedTag) {
  const manifest = JSON.parse(
    await readFile(join(path, "package.json"), "utf8"),
  );
  const tauri = JSON.parse(
    await readFile(join(path, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const windows = JSON.parse(
    await readFile(join(path, "src-tauri/tauri.windows.conf.json"), "utf8"),
  );
  const macos = JSON.parse(
    await readFile(join(path, "src-tauri/tauri.macos.conf.json"), "utf8"),
  );
  const cargo = await readFile(join(path, "src-tauri/Cargo.toml"), "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
  const mcpCargo = await readFile(
    join(path, "apps/mcp-server/Cargo.toml"),
    "utf8",
  );
  const obfuscatorCargo = await readFile(
    join(path, "apps/obfuscator/Cargo.toml"),
    "utf8",
  );
  const mcpVersion = /^version\s*=\s*"([^"]+)"/m.exec(mcpCargo)?.[1];
  const obfuscatorVersion = /^version\s*=\s*"([^"]+)"/m.exec(
    obfuscatorCargo,
  )?.[1];
  if (
    manifest.name !== "ispoofermotion" ||
    tauri.identifier !== "com.ispoofermotion.desktop" ||
    tauri.version !== "../package.json" ||
    match?.[1] !== manifest.version ||
    mcpVersion !== manifest.version ||
    obfuscatorVersion !== manifest.version ||
    JSON.stringify(windows.bundle.targets) !== JSON.stringify(["nsis"]) ||
    JSON.stringify(macos.bundle.targets) !== JSON.stringify(["app", "dmg"])
  ) {
    throw new Error(
      "Desktop source does not match the supported Tauri application contract",
    );
  }
  validateVersion(manifest.version);
  if (expectedTag && expectedTag !== `v${manifest.version}`)
    throw new Error("Release tag differs from application version");
  return manifest.version;
}
