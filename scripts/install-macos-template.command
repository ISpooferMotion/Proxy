#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
package_dir="$(pwd -P)"
expected_arch="__ARCH__"

if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'This installer must be run on macOS.\n' >&2
    exit 1
fi
if [[ "$(uname -m)" != "$expected_arch" ]]; then
    printf 'Wrong test package architecture: this package is for %s, this session is %s.\n' "$expected_arch" "$(uname -m)" >&2
    exit 1
fi
if [[ -z "${HOME:-}" || ! -d "$HOME" ]]; then
    printf 'Cannot locate the current user home directory.\n' >&2
    exit 1
fi

components=(daemon ui mcp-server libISpooferMotion.dylib
    .ispoofermotion-daemon-version .ispoofermotion-ui-version
    .ispoofermotion-install-integrity.json)
for file in "${components[@]}"; do
    if [[ ! -f "$package_dir/bin/$file" || -L "$package_dir/bin/$file" ]]; then
        printf 'Missing or unsafe test component: %s\n' "$file" >&2
        exit 1
    fi
done
if [[ ! -f "$package_dir/bin/SHA256SUMS" || -L "$package_dir/bin/SHA256SUMS" ]]; then
    printf 'Test package checksum file is missing.\n' >&2
    exit 1
fi

# Verify every binary and both hidden version files before changing any
# installed component. This is transport integrity, not a code-signature check.
(cd "$package_dir" && /usr/bin/shasum -a 256 -c bin/SHA256SUMS) || {
    printf 'Test build integrity verification failed. Re-extract the ZIP.\n' >&2
    exit 1
}

app_dir="$HOME/Library/Application Support/ISpooferMotion"
destination="$app_dir/bin"
if [[ -L "$app_dir" || -L "$destination" ]]; then
    printf 'Refusing to install through a symbolic link.\n' >&2
    exit 1
fi
/bin/mkdir -p "$app_dir"
if [[ -d "$destination" ]]; then
    printf 'This will replace the current ISpooferMotion runtime in %s. Continue? [y/N] ' "$destination"
    read -r answer
    if [[ "$answer" != 'y' && "$answer" != 'Y' ]]; then
        printf 'Cancelled.\n'
        exit 0
    fi
elif [[ -e "$destination" ]]; then
    printf 'The runtime destination exists and is not a directory.\n' >&2
    exit 1
fi

stage_root="$(/usr/bin/mktemp -d "$app_dir/.test-stage.XXXXXXXX")"
backup_root=''
cleanup() {
    [[ -z "$stage_root" || ! -d "$stage_root" ]] || /bin/rm -rf -- "$stage_root"
    # Never silently delete the existing install on a failed swap.
}
trap cleanup EXIT
/bin/mkdir "$stage_root/bin"
for file in "${components[@]}"; do
    /bin/cp -p "$package_dir/bin/$file" "$stage_root/bin/$file"
done
/bin/chmod 755 "$stage_root/bin/daemon" "$stage_root/bin/ui" "$stage_root/bin/mcp-server" "$stage_root/bin/libISpooferMotion.dylib"
(cd "$stage_root" && /usr/bin/shasum -a 256 -c "$package_dir/bin/SHA256SUMS") || {
    printf 'Runtime copy verification failed; no installed files were changed.\n' >&2
    exit 1
}

if [[ -d "$destination" ]]; then
    backup_root="$(/usr/bin/mktemp -d "$app_dir/.test-backup.XXXXXXXX")"
    /bin/mv "$destination" "$backup_root/bin"
fi
if ! /bin/mv "$stage_root/bin" "$destination"; then
    if [[ -n "$backup_root" ]]; then
        /bin/mv "$backup_root/bin" "$destination" || printf 'IMPORTANT: previous runtime is in %s\n' "$backup_root/bin" >&2
    fi
    printf 'Could not install the test runtime.\n' >&2
    exit 1
fi
if [[ -n "$backup_root" ]]; then
    /bin/rm -rf -- "$backup_root"
fi
printf '\nTest runtime installed and verified at:\n%s\n' "$destination"
printf 'You can now install and open the included Loader DMG.\n'
