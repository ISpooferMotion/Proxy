import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import contract from "../release-contract.json" with { type: "json" };

const [artifactPath, signaturePathArg] = process.argv.slice(2);
if (!artifactPath) {
  throw new Error("Usage: sign-tauri-artifact.mjs <artifact-path> [signature-path]");
}

const signaturePath = signaturePathArg || `${artifactPath}.sig`;
const privateKeyPem = process.env.UPDATER_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!privateKeyPem) {
  throw new Error("UPDATER_PRIVATE_KEY environment variable is required to sign Tauri artifacts");
}

const privateKey = createPrivateKey(privateKeyPem);
const pubHex = contract.releasePublicKeyHex || "7cca204c5e75d413d66e43aa4802f2ace3fc17c02671033ea6372f88a0df29f2";
const pubBytes = Buffer.from(pubHex, "hex");
const keyId = pubBytes.subarray(0, 8); // 8 bytes key ID: 7cca204c5e75d413

const artifactBytes = await readFile(artifactPath);
const digest = createHash("blake2b512").update(artifactBytes).digest();
const signature = sign(null, digest, privateKey);
const signatureRecord = Buffer.concat([Buffer.from("ED"), keyId, signature]);
const signatureText = `untrusted comment: signature from tauri secret key\n${signatureRecord.toString("base64")}\n`;
await writeFile(signaturePath, signatureText);
console.log(`Signed ${artifactPath} -> ${signaturePath}`);
