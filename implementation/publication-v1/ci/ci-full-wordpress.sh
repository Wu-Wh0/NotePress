#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PUB_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$PUB_ROOT/../.." && pwd -P)"

if [[ -z "${TMPDIR:-}" ]]; then
  if [[ -n "${RUNNER_TEMP:-}" ]]; then
    export TMPDIR="$RUNNER_TEMP"
  else
    export TMPDIR="$(python3 -c 'import tempfile; print(tempfile.gettempdir())')"
  fi
fi
mkdir -p -- "$TMPDIR"
runtime_root="${PUBLICATION_RUNTIME_ROOT:-$TMPDIR/publication-v1-full-$$}"
node_bin="${PUBLICATION_NODE:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then printf '%s\n' 'Node v24.21.0 is required; set PUBLICATION_NODE' >&2; exit 2; fi

export PUBLICATION_RUNTIME_ROOT="$runtime_root"
export PUBLICATION_NODE="$node_bin"
export PUBLICATION_TOOLCHAIN_ROOT="${PUBLICATION_TOOLCHAIN_ROOT:-$PUB_ROOT/producer}"
export PUBLICATION_PARSER_ROOT="${PUBLICATION_PARSER_ROOT:-$runtime_root/parser}"
export PUBLICATION_PHP_WASM_MODULES="${PUBLICATION_PHP_WASM_MODULES:-$runtime_root/wordpress/node_modules}"
export PUBLICATION_WP_CORE="${PUBLICATION_WP_CORE:-$runtime_root/wordpress/core/wordpress}"
export PATH="$(dirname -- "$node_bin"):$PATH"
export PYTHONDONTWRITEBYTECODE=1

bash "$SCRIPT_DIR/ci-bootstrap.sh" "$runtime_root"
bash "$SCRIPT_DIR/prepare-wordpress-core.sh" "$PUBLICATION_WP_CORE"

python3 -B -m unittest discover -s "$PUB_ROOT/tests" -p 'test_*.py' -v
"$node_bin" --test "$PUB_ROOT/tests/test_plugin_selection.js" "$PUB_ROOT/tests/test_plugin_entry.js" "$PUB_ROOT/tests/test_session_launcher_argv.js" "$PUB_ROOT/tests/test_plugin_build.js"
if command -v php >/dev/null; then
  for file in "$PUB_ROOT"/server/*.php; do php -l "$file"; done
else
  printf '%s\n' 'PHP CLI unavailable locally; mandatory syntax lint remains in the fast Ubuntu CI job'
fi
printf '%s\n' 'publication-v1 full synthetic producer/WordPress regression passed'
