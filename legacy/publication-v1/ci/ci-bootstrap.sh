#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PUB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$PUB_ROOT/../.." && pwd -P)"
PRODUCER="$PUB_ROOT/producer"

runtime_root="${1:-${PUBLICATION_RUNTIME_ROOT:-}}"
if [[ -z "$runtime_root" ]]; then
  temp_parent="${TMPDIR:-${RUNNER_TEMP:-}}"
  if [[ -z "$temp_parent" ]]; then
    temp_parent="$(python3 -c 'import tempfile; print(tempfile.gettempdir())')"
  fi
  runtime_root="$temp_parent/publication-v1-runtime"
fi
if [[ -L "$runtime_root" ]]; then printf '%s\n' 'runtime root must not be a symlink' >&2; exit 2; fi
mkdir -p -- "$runtime_root"
runtime_root="$(cd -- "$runtime_root" && pwd -P)"
case "$runtime_root/" in
  "$REPO_ROOT/"*) printf '%s\n' 'refusing to install CI dependencies inside the checkout' >&2; exit 2 ;;
esac

node_bin="${PUBLICATION_NODE:-$(command -v node || true)}"
if [[ -z "$node_bin" || -L "$node_bin" || ! -f "$node_bin" ]]; then
  printf '%s\n' 'PUBLICATION_NODE must be a regular Node v24.21.0 executable' >&2
  exit 2
fi
node_version="$("$node_bin" --version)"
if [[ "$node_version" != 'v24.21.0' ]]; then
  printf 'expected Node v24.21.0, got %s\n' "$node_version" >&2
  exit 2
fi
export PUBLICATION_NODE="$node_bin"
export PATH="$(dirname -- "$node_bin"):$PATH"

parser_root="${PUBLICATION_PARSER_ROOT:-$runtime_root/parser}"
modules_root="${PUBLICATION_PHP_WASM_MODULES:-$runtime_root/wordpress/node_modules}"
if [[ "$(basename -- "$modules_root")" != node_modules ]]; then
  printf '%s\n' 'PUBLICATION_PHP_WASM_MODULES must point to a node_modules directory' >&2
  exit 2
fi
wordpress_root="$(dirname -- "$modules_root")"
toolchain_root="${PUBLICATION_TOOLCHAIN_ROOT:-$PRODUCER}"
for path in "$parser_root" "$wordpress_root" "$toolchain_root"; do
  if [[ -L "$path" ]]; then printf '%s\n' 'runtime and toolchain roots must not be symlinks' >&2; exit 2; fi
done
mkdir -p -- "$parser_root" "$wordpress_root"
parser_root="$(cd -- "$parser_root" && pwd -P)"
wordpress_root="$(cd -- "$wordpress_root" && pwd -P)"
for path in "$parser_root" "$wordpress_root"; do
  case "$path/" in
    "$REPO_ROOT/"*) printf '%s\n' 'refusing to install CI dependencies inside the checkout' >&2; exit 2 ;;
  esac
done

npm_bin="${PUBLICATION_NPM:-$(command -v npm || true)}"
if [[ -z "$npm_bin" ]]; then printf '%s\n' 'npm is required for the pinned CI bootstrap' >&2; exit 2; fi
if [[ "$npm_bin" == *.js ]]; then
  npm_cmd=("$node_bin" "$npm_bin")
else
  npm_cmd=("$npm_bin")
fi
npm_version="$("${npm_cmd[@]}" --version)"
printf 'npm %s\n' "$npm_version"

cp -- "$toolchain_root/package.json" "$toolchain_root/package-lock.json" "$parser_root/"
cp -- "$PUB_ROOT/ci/wordpress-runtime/package.json" "$PUB_ROOT/ci/wordpress-runtime/package-lock.json" "$wordpress_root/"
"${npm_cmd[@]}" ci --prefix "$parser_root" --ignore-scripts --no-audit --no-fund --engine-strict \
  --cache "$runtime_root/npm-cache/parser" --registry https://registry.npmjs.org/ --loglevel=error
"${npm_cmd[@]}" ci --prefix "$wordpress_root" --ignore-scripts --no-audit --no-fund --engine-strict \
  --cache "$runtime_root/npm-cache/wordpress" --registry https://registry.npmjs.org/ --loglevel=error

export PUBLICATION_TOOLCHAIN_ROOT="$toolchain_root"
export PUBLICATION_PARSER_ROOT="$parser_root"
export PUBLICATION_PHP_WASM_MODULES="$modules_root"
PYTHONPATH="$PRODUCER${PYTHONPATH:+:$PYTHONPATH}" python3 -B -c 'import package_builder; print("producer toolchain:", package_builder._toolchain())'
"$node_bin" -e 'const fs=require("node:fs"),path=require("node:path"),root=process.argv[1]; for(const name of ["@php-wasm/node-8-3","@php-wasm/universal","@wp-playground/wordpress","@wp-playground/cli"]){const file=path.join(root,name,"package.json"); if(fs.lstatSync(file).isSymbolicLink()||JSON.parse(fs.readFileSync(file,"utf8")).version!=="3.1.56") throw Error("pinned PHP-WASM package mismatch: "+name);} const zip=path.join(root,"@wp-playground/cli/sqlite-database-integration.zip"); if(fs.lstatSync(zip).isSymbolicLink()||!fs.statSync(zip).isFile()) throw Error("pinned SQLite integration ZIP missing"); console.log("PHP-WASM 8.3/WordPress Playground 3.1.56 and SQLite ZIP verified")' "$modules_root"
printf 'portable dependencies installed under %s\n' "$runtime_root"
