#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PUB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$PUB_ROOT/../.." && pwd -P)"
LOCK_FILE="$PUB_ROOT/ci/wordpress-core.lock.json"

target="${1:-${PUBLICATION_WP_CORE:-}}"
if [[ -z "$target" ]]; then printf '%s\n' 'PUBLICATION_WP_CORE must name the verified core extraction target' >&2; exit 2; fi
if [[ -L "$target" || -e "$target" ]]; then printf '%s\n' 'refusing to overwrite an existing or symlinked WordPress core target' >&2; exit 2; fi
parent="$(dirname -- "$target")"
mkdir -p -- "$parent"
parent="$(cd -- "$parent" && pwd -P)"
case "$parent/$(basename -- "$target")/" in
  "$REPO_ROOT/"*) printf '%s\n' 'WordPress core must be prepared outside the checkout' >&2; exit 2 ;;
esac

mapfile -t fields < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(d.get("version","")); print(d.get("archive_url","")); print(d.get("archive_sha256",""))' "$LOCK_FILE")
if (( ${#fields[@]} != 3 )); then printf '%s\n' 'invalid pinned WordPress core lock' >&2; exit 2; fi
version="${fields[0]}"
url="${fields[1]}"
expected_sha="${fields[2]}"
if [[ "$version" != '7.1.2' || "$url" != 'https://wordpress.org/wordpress-7.1.2.tar.gz' || ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'invalid pinned WordPress core lock' >&2
  exit 2
fi

tmp="$parent/.wordpress-core-prep-$$"
mkdir -m 700 -- "$tmp"
cleanup() { rm -rf -- "$tmp"; }
trap cleanup EXIT
archive="$tmp/wordpress.tar.gz"
effective_url="$(curl --proto '=https' --proto-redir '=https' --max-redirs 2 --fail --location --silent --show-error \
  --output "$archive" --write-out '%{url_effective}' "$url")"
if [[ "$effective_url" != "$url" ]]; then printf '%s\n' 'WordPress archive redirected outside its pinned official URL' >&2; exit 2; fi
actual_sha="$(sha256sum "$archive" | cut -d ' ' -f 1)"
if [[ "$actual_sha" != "$expected_sha" ]]; then printf '%s\n' 'WordPress core archive SHA-256 mismatch' >&2; exit 2; fi

tar -tzf "$archive" | python3 -c 'import sys; from pathlib import PurePosixPath; names=[line.rstrip("\n") for line in sys.stdin]; assert names and all(PurePosixPath(n).parts and PurePosixPath(n).parts[0]=="wordpress" and not PurePosixPath(n).is_absolute() and ".." not in PurePosixPath(n).parts for n in names), "unsafe WordPress archive path"'
tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$tmp"
python3 -c 'import sys; from pathlib import Path; f=Path(sys.argv[1])/"wp-includes/version.php"; text=f.read_text(encoding="utf-8"); expected="$wp_version = " + repr(sys.argv[2]) + ";"; assert expected in text, "WordPress core version mismatch"' "$tmp/wordpress" "$version"
mv -- "$tmp/wordpress" "$target"
printf 'verified official WordPress core %s (sha256 %s)\n' "$version" "$actual_sha"
