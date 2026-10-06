"""Fail-closed resolver for portable test runtimes."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_ROOT = REPOSITORY_ROOT / "ci" / "runtime"


def _directory(variable: str, default: Path) -> Path:
    value = os.environ.get(variable)
    path = Path(value) if value else default
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError(f"{variable} must name an existing non-symlink directory")
    return path


def node_binary() -> Path:
    value = os.environ.get("PUBLICATION_NODE")
    discovered = value or shutil.which("node")
    if not discovered:
        raise RuntimeError("PUBLICATION_NODE must point to Node v24.21.0")
    path = Path(discovered)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("PUBLICATION_NODE must point to a regular Node executable")
    try:
        result = subprocess.run([str(path), "--version"], check=True, text=True, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("PUBLICATION_NODE must run Node v24.21.0") from exc
    if result.stdout.strip() != "v24.21.0":
        raise RuntimeError("PUBLICATION_NODE must run Node v24.21.0")
    return path


def parser_root() -> Path:
    return _directory("PUBLICATION_PARSER_ROOT", RUNTIME_ROOT / "parser")


def php_wasm_modules() -> Path:
    return _directory("PUBLICATION_PHP_WASM_MODULES", RUNTIME_ROOT / "wordpress" / "node_modules")


def wordpress_core() -> Path:
    path = _directory("PUBLICATION_WP_CORE", RUNTIME_ROOT / "wordpress" / "core" / "wordpress")
    version_file = path / "wp-includes" / "version.php"
    if version_file.is_symlink() or not version_file.is_file():
        raise RuntimeError("PUBLICATION_WP_CORE must contain WordPress 7.1.2 core")
    expected_line = f"$wp_version = {'7.1.2'!r};"
    if expected_line not in version_file.read_text(encoding="utf-8"):
        raise RuntimeError("PUBLICATION_WP_CORE must contain WordPress 7.1.2 core")
    return path
