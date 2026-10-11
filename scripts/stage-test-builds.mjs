// Stage integrity-checked offline test ZIPs with Node.js only.
// ZIP entries are inspected by central-directory offsets and extracted into
// filenames controlled by this script, never by untrusted member paths.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZipEntry, writeZip, zipEntries } from './test-build-zip.mjs';

const platforms = new Map([
  ['windows-x86_64', ['daemon.exe', 'ui.exe', 'mcp-server.exe', 'ISpooferMotion.dll']],
  ['macos-x86_64', ['daemon', 'ui', 'mcp-server', 'libISpooferMotion.dylib']],
  ['macos-aarch64', ['daemon', 'ui', 'mcp-server', 'libISpooferMotion.dylib']],
]);
const MAX_ARCHIVE = 500 * 1024 * 1024;
const scripts = fileURLToPath(new URL('.', import.meta.url));
const sha256 = async (path) => {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest('hex');
};
const digestText = (text) => createHash('sha256').update(text).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
function within(path, root) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !part.startsWith(sep);
}
async function regularFile(path, root) {
  const details = await lstat(path);
  check(details.isFile() && !details.isSymbolicLink() && within(await realpath(path), await realpath(root)),
    `Missing or unsafe artifact: ${path}`);
  check(details.size > 0 && details.size <= MAX_ARCHIVE, `Empty or oversized artifact: ${path}`);
  return path;
}
async function findUnique(root, name) {
  const matches = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await scan(path);
      else if (entry.name === name) matches.push(path);
    }
  }
  await scan(root);
  check(matches.length === 1, `Expected one artifact named ${name}, got ${matches.length}`);
  return regularFile(matches[0], root);
}
async function verifyRuntime(path, root) {
  const checksum = await findUnique(root, `${basename(path)}.sha256`);
  const checksumText = (await readFile(checksum, 'ascii')).trim();
  const match = /^([a-fA-F0-9]{64})  ([^/\\\r\n]+)$/.exec(checksumText);
  check(match && match[2] === basename(path) && match[1].toLowerCase() === await sha256(path),
    `Runtime artifact checksum mismatch: ${basename(path)}`);
}
function checksumText(files, texts) {
  const list = [...files.entries()].filter(([name]) => name.startsWith('bin/')).map(async ([name, path]) => [name, await sha256(path)]);
  for (const [name, body] of texts) if (name.startsWith('bin/')) list.push(Promise.resolve([name, digestText(body)]));
  return Promise.all(list).then(entries => entries.sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, hash]) => `${hash}  ${name}\n`).join(''));
}
const macInstructions =
  'ISpooferMotion offline macOS test build\n\n' +
  '1. Extract the entire test ZIP. Do not run the DMG by itself.\n' +
  '2. Close ISpooferMotion if it is open.\n' +
  "3. Open Terminal, type 'bash ' (with a trailing space), then drag\n" +
  '   INSTALL-MACOS.command into the Terminal window and press Return.\n' +
  '   Confirm replacement if you already have an installed runtime.\n' +
  '4. The installer checks all runtime hashes, copies the executable and\n' +
  '   hidden metadata files to ~/Library/Application Support/ISpooferMotion/bin/,\n' +
  '   and verifies the copy before replacing an existing runtime.\n' +
  '5. Open the included Loader DMG, install the app and launch it.\n\n' +
  'Use the test ZIP matching your Mac architecture. macos-aarch64 is Apple Silicon;\n' +
  'macos-x86_64 is Intel. The test loader uses local runtime components and\n' +
  'does not fetch the latest published runtime release.\n';

export async function stageTestBuilds(input, output, version) {
  check(/^\d+\.\d+\.\d+$/.test(version || ''), `Invalid test build version: ${version}`);
  const artifacts = await realpath(input);
  const destination = resolve(output);
  check(!within(destination, artifacts) && destination !== artifacts, 'Output must not be within artifacts');
  await mkdir(destination, { recursive: true });
  check((await readdir(destination)).length === 0, 'Test output directory must start empty');
  const scratch = await mkdtemp(join(tmpdir(), 'ism-test-packages-'));
  try {
    const template = await readFile(join(scripts, 'install-macos-template.command'), 'utf8');
    const checksums = [];
    for (const [label, components] of platforms) {
      const runtime = await findUnique(artifacts, `ISpooferMotion-${label}.zip`);
      await verifyRuntime(runtime, artifacts);
      const entries = await zipEntries(runtime);
      check(entries.size === components.length && components.every(name => entries.has(name)),
        `Wrong runtime component set in ${basename(runtime)}`);
      const platformDir = join(scratch, label);
      await mkdir(platformDir);
      const files = new Map();
      const componentHashes = {};
      for (const name of components) {
        const path = join(platformDir, name);
        await extractZipEntry(runtime, entries.get(name), path);
        files.set(`bin/${name}`, path);
        componentHashes[name] = await sha256(path);
      }
      const texts = new Map([
        ['bin/.ispoofermotion-daemon-version', `${version}\n`],
        ['bin/.ispoofermotion-ui-version', `${version}\n`],
        ['bin/.ispoofermotion-install-integrity.json', JSON.stringify({ version, components: componentHashes }, null, 2) + '\n'],
      ]);
      if (label === 'windows-x86_64') {
        files.set('ISpooferMotion.exe', await findUnique(artifacts, `ISpooferMotion-Loader-${version}-${label}.exe`));
      } else {
        const dmg = await findUnique(artifacts, `ISpooferMotion-Loader-${version}-${label}.dmg`);
        files.set(basename(dmg), dmg);
        texts.set('bin/SHA256SUMS', await checksumText(files, texts));
        texts.set('INSTALL-MACOS.command', template.replaceAll('__ARCH__', label === 'macos-aarch64' ? 'arm64' : 'x86_64'));
        texts.set('INSTALL-MACOS.txt', macInstructions);
      }
      const members = [
        ...[...files].map(([name, file]) => ({ name, file, executable: name.startsWith('bin/') && !name.endsWith('.json') && !name.endsWith('-version') })),
        ...[...texts].map(([name, text]) => ({ name, text, executable: name.endsWith('.command') })),
      ].sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const zip = join(destination, `ISpooferMotion-${version}-${label}-test.zip`);
      await writeZip(zip, members);
      check((await stat(zip)).size <= MAX_ARCHIVE, `Test bundle exceeds size limit: ${basename(zip)}`);
      checksums.push(`${await sha256(zip)}  ${basename(zip)}`);
      console.log(`Packaged ${basename(zip)}: ${members.map(x => x.name).join(', ')}`);
    }
    await writeFile(join(destination, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'ascii');
    console.log(`Staged ${checksums.length} offline platform bundles in ${destination}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, version] = process.argv.slice(2);
  if (!input || !output || !version) {
    console.error('Usage: node stage-test-builds.mjs <artifacts> <destination> <version>');
    process.exitCode = 1;
  } else {
    stageTestBuilds(input, output, version).catch(error => {
      console.error(`Test packaging failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
