import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const [
  artifactPath,
  signaturePath,
  publicKeyValue = process.env.TAURI_PUBLIC_KEY,
] = process.argv.slice(2);
if (!artifactPath || !signaturePath || !publicKeyValue) {
  throw new Error(
    "Usage: verify-tauri-signature.mjs <artifact> <signature> [tauri-public-key]",
  );
}

function decodeTauriPublicKey(value) {
  let text = value.trim();
  if (!text.includes("\n") && !text.startsWith("untrusted comment:")) {
    text = Buffer.from(text, "base64").toString("utf8");
  }
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => /^[A-Za-z0-9+/]+={0,2}$/.test(part) && part.length >= 50);
  if (!line)
    throw new Error("TAURI_PUBLIC_KEY is not a valid minisign public key");
  const decoded = Buffer.from(line, "base64");
  if (decoded.length !== 42)
    throw new Error("Tauri public key has an invalid length");
  return decoded;
}

function decodeSignature(value) {
  let text = value.trim();
  if (!text.includes("\n") && !text.startsWith("untrusted comment:")) {
    text = Buffer.from(text, "base64").toString("utf8");
  }
  const line = text
    .trim()
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => /^[A-Za-z0-9+/]+={0,2}$/.test(part) && part.length >= 90);
  if (!line) throw new Error("Updater signature is not valid minisign data");
  const decoded = Buffer.from(line, "base64");
  if (decoded.length !== 74)
    throw new Error("Updater signature has an invalid length");
  return decoded;
}

const publicKey = decodeTauriPublicKey(publicKeyValue);
const signature = decodeSignature(await readFile(signaturePath, "utf8"));
if (!publicKey.subarray(2, 10).equals(signature.subarray(2, 10))) {
  throw new Error("Updater signature key ID does not match TAURI_PUBLIC_KEY");
}

const algorithm = signature.subarray(0, 2).toString("ascii");
const artifact = await readFile(artifactPath);
const message =
  algorithm === "ED"
    ? createHash("blake2b512").update(artifact).digest()
    : algorithm === "Ed"
      ? artifact
      : null;
if (!message) throw new Error(`Unsupported minisign algorithm: ${algorithm}`);

const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const key = createPublicKey({
  key: Buffer.concat([spkiPrefix, publicKey.subarray(10)]),
  format: "der",
  type: "spki",
});
if (!verify(null, message, key, signature.subarray(10))) {
  throw new Error("Updater artifact signature verification failed");
}
