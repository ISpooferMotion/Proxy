"""Stage one integrity-checked, offline test ZIP per target architecture.

The source artifacts are built by separate signed CI jobs. Never extract an
untrusted archive by pathname, and never add a production updater bundle here.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

PLATFORMS = {
    "windows-x86_64": ("daemon.exe", "ui.exe", "mcp-server.exe", "ISpooferMotion.dll"),
    "macos-x86_64": ("daemon", "ui", "mcp-server", "libISpooferMotion.dylib"),
    "macos-aarch64": ("daemon", "ui", "mcp-server", "libISpooferMotion.dylib"),
}
MAX_FILE_BYTES = 300 * 1024 * 1024
MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
MAX_UNPACKED_BYTES = 750 * 1024 * 1024
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def require_regular_file(path: Path, base: Path) -> Path:
    if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(base.resolve()):
        raise ValueError(f"Missing or unsafe artifact: {path}")
    if not 0 < path.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise ValueError(f"Empty or oversized artifact: {path}")
    return path


def find_unique(base: Path, name: str) -> Path:
    matches = [path for path in base.rglob(name) if path.name == name]
    if len(matches) != 1:
        raise ValueError(f"Expected one artifact named {name}, got {len(matches)}")
    return require_regular_file(matches[0], base)


def verify_runtime_checksum(path: Path, artifacts: Path) -> None:
    checksum = find_unique(artifacts, f"{path.name}.sha256")
    body = checksum.read_text("ascii").strip()
    match = re.fullmatch(r"([a-fA-F0-9]{64})  ([^/\\\r\n]+)", body)
    if not match or match.group(2) != path.name or match.group(1).lower() != digest(path):
        raise ValueError(f"Runtime artifact checksum mismatch: {path.name}")


def extract_runtime(path: Path, names: tuple[str, ...], destination: Path) -> None:
    allowed = set(names)
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) != len(allowed) or {entry.filename for entry in entries} != allowed:
            raise ValueError(f"Wrong runtime component set in {path.name}")
        if sum(entry.file_size for entry in entries) > MAX_UNPACKED_BYTES:
            raise ValueError(f"Runtime archive is too large: {path.name}")
        for entry in entries:
            mode = (entry.external_attr >> 16) & 0o170000
            if (
                entry.is_dir()
                or entry.flag_bits & 1
                or mode not in (0, 0o100000)
                or not 0 < entry.file_size <= MAX_FILE_BYTES
            ):
                raise ValueError(f"Unsafe runtime ZIP member: {entry.filename}")
            with archive.open(entry, "r") as reader, (destination / entry.filename).open("wb") as writer:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
            if (destination / entry.filename).stat().st_size != entry.file_size:
                raise ValueError(f"Truncated runtime ZIP member: {entry.filename}")


def write_test_zip(path: Path, files: dict[str, Path], texts: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9,
                         allowZip64=True) as archive:
        for filename, file_path in sorted(files.items()):
            info = zipfile.ZipInfo(filename, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if filename.startswith("bin/") and
                                  not filename.endswith((".json", "-version")) else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with file_path.open("rb") as source, archive.open(info, "w", force_zip64=True) as sink:
                shutil.copyfileobj(source, sink, 1024 * 1024)
        for filename, content in sorted(texts.items()):
            info = zipfile.ZipInfo(filename, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)


def main() -> None:
    if len(sys.argv) != 4:
        raise ValueError("Usage: stage-test-builds.py <artifacts> <destination> <version>")
    artifacts = Path(sys.argv[1]).resolve(strict=True)
    destination = Path(sys.argv[2]).resolve()
    version = sys.argv[3]
    if not VERSION.fullmatch(version):
        raise ValueError(f"Invalid test build version: {version!r}")
    if destination == artifacts or destination.is_relative_to(artifacts):
        raise ValueError("Test bundles must be staged outside the artifact input directory")

    destination.mkdir(parents=True, exist_ok=True)
    # Avoid silently publishing leftovers from an earlier run.
    if any(destination.iterdir()):
        raise ValueError("Test output directory must start empty")
    checksums = []
    with tempfile.TemporaryDirectory(prefix="ism-test-packages-") as scratch:
        for label, components in PLATFORMS.items():
            runtime_path = find_unique(artifacts, f"ISpooferMotion-{label}.zip")
            verify_runtime_checksum(runtime_path, artifacts)
            platform_dir = Path(scratch) / label
            platform_dir.mkdir()
            extract_runtime(runtime_path, components, platform_dir)

            files = {f"bin/{name}": platform_dir / name for name in components}
            hashes = {name: digest(platform_dir / name) for name in components}
            texts = {
                "bin/.ispoofermotion-daemon-version": f"{version}\n",
                "bin/.ispoofermotion-ui-version": f"{version}\n",
                "bin/.ispoofermotion-install-integrity.json": json.dumps(
                    {"version": version, "components": hashes}, indent=2
                ) + "\n",
            }
            if label == "windows-x86_64":
                # This is the original signed loader executable, not an NSIS installer.
                loader = find_unique(artifacts, f"ISpooferMotion-Loader-{version}-{label}.exe")
                files["ISpooferMotion.exe"] = loader
            else:
                installer = find_unique(artifacts, f"ISpooferMotion-Loader-{version}-{label}.dmg")
                files[installer.name] = installer
                texts["INSTALL-MACOS.txt"] = (
                    "ISpooferMotion offline test build\n\n"
                    "1. Extract this whole ZIP.\n"
                    "2. Copy the contents of bin/ into\n"
                    "   ~/Library/Application Support/ISpooferMotion/bin/\n"
                    "   (create the directory if needed; include the three hidden .ispoofermotion files).\n"
                    "3. Install the included signed Loader DMG and start the app.\n"
                    "   The test loader uses the local, hash-verified components and does not\n"
                    "   fetch the latest published runtime release.\n"
                )

            output = destination / f"ISpooferMotion-{version}-{label}-test.zip"
            write_test_zip(output, files, texts)
            if output.stat().st_size > MAX_ARCHIVE_BYTES:
                output.unlink()
                raise ValueError(f"Test bundle exceeds size limit: {output.name}")
            checksums.append(f"{digest(output)}  {output.name}")
            print(f"Packaged {output.name}: {', '.join(sorted(files | texts))}")

    (destination / "SHA256SUMS").write_text("\n".join(checksums) + "\n", encoding="ascii")
    print(f"Staged {len(checksums)} self-contained platform bundles in {destination}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.exit(f"Test packaging failed: {error}")
