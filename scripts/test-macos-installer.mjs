// Mock macOS uname to test the installer's actual Bash code on a Linux runner.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZipEntry, zipEntries } from './test-build-zip.mjs';

function check(condition, message) { if (!condition) throw new Error(message); }
function runInstaller(command, environment, success, answer = '') {
  try {
    execFileSync('bash', [command], {
      cwd: resolve(command, '..'), env: environment, input: answer, encoding: 'utf8', timeout: 20000,
      stdio: 'pipe',
    });
    check(success, 'Installer unexpectedly accepted a rejected scenario');
  } catch (error) {
    if (error.message === 'Installer unexpectedly accepted a rejected scenario') throw error;
    if (success) throw new Error(`Installer unexpectedly failed: ${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  }
}
async function testPlatform(bundle, arch) {
  const dir = await mkdtemp(join(tmpdir(), 'ism-mac-install-test-'));
  try {
    const packageDir = join(dir, 'package');
    await mkdir(join(packageDir, 'bin'), { recursive: true });
    const entries = await zipEntries(bundle);
    for (const name of entries.keys()) {
      const path = join(packageDir, name);
      await extractZipEntry(bundle, entries.get(name), path);
    }
    const mockBin = join(dir, 'mockbin');
    await mkdir(mockBin);
    const uname = join(mockBin, 'uname');
    const setArch = async (value) => {
      await writeFile(uname, `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo ${value}; fi\n`);
      await chmod(uname, 0o755);
    };
    await setArch(arch);
    const home = join(dir, 'home');
    await mkdir(home);
    const env = { ...process.env, HOME: home, PATH: `${mockBin}:${process.env.PATH ?? ''}` };
    const installer = join(packageDir, 'INSTALL-MACOS.command');
    const installed = join(home, 'Library/Application Support/ISpooferMotion/bin');
    runInstaller(installer, env, true);
    check((await readFile(join(installed, '.ispoofermotion-install-integrity.json'))).length > 0,
      'Installed integrity marker missing');
    check((await readFile(join(installed, 'daemon'))).equals(await readFile(join(packageDir, 'bin/daemon'))),
      'Installed daemon does not match the package');
    runInstaller(installer, env, true, 'y\n');
    await writeFile(join(packageDir, 'bin/daemon'), 'tampered');
    runInstaller(installer, env, false);
    check(!(await readFile(join(installed, 'daemon'))).equals(Buffer.from('tampered')),
      'Tampered daemon was installed');
    await setArch(arch === 'arm64' ? 'x86_64' : 'arm64');
    runInstaller(installer, env, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function testMacInstallers(output, version) {
  await testPlatform(join(output, `ISpooferMotion-${version}-macos-aarch64-test.zip`), 'arm64');
  await testPlatform(join(output, `ISpooferMotion-${version}-macos-x86_64-test.zip`), 'x86_64');
  console.log('macOS offline installer simulations passed (both architectures)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, version] = process.argv.slice(2);
  if (!output || !version) {
    console.error('Usage: node test-macos-installer.mjs <test-build-directory> <version>');
    process.exitCode = 1;
  } else {
    testMacInstallers(output, version).catch(error => {
      console.error(`macOS installer test failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
